import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { intakeHar } from '../src/intake/har'
import { intakeJourney, splitSteps } from '../src/intake/journey'
import { intakeOpenApi } from '../src/intake/openapi'
import { TargetNotAllowedError } from '../src/security/allowlist'
import { testConfig } from './helpers'

const config = testConfig('data/unused')

describe('intakes', () => {
  it('turns an OpenAPI document into one scenario', async () => {
    const draft = await intakeOpenApi({
      openapi: '3.0.3',
      info: { title: 'Local API', version: '1.0.0' },
      servers: [{ url: 'http://127.0.0.1:4010/api' }],
      components: {
        securitySchemes: {
          bearerAuth: { type: 'http', scheme: 'bearer' }
        }
      },
      security: [{ bearerAuth: [] }],
      paths: {
        '/items': {
          post: {
            operationId: 'createItem',
            requestBody: {
              required: true,
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['name'],
                    properties: { name: { type: 'string' } }
                  }
                }
              }
            },
            responses: {
              '201': {
                description: 'created',
                content: {
                  'application/json': {
                    schema: { type: 'object', properties: { id: { type: 'string' } } }
                  }
                }
              }
            }
          }
        },
        '/items/{id}': {
          get: {
            operationId: 'getItem',
            parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
            responses: { '200': { description: 'ok' } }
          }
        }
      }
    }, config)

    assert.equal(draft.model.baseUrl, 'http://127.0.0.1:4010')
    assert.equal(draft.model.auth?.type, 'bearer')
    assert.equal(draft.model.scenarios[0].calls[0].name, 'createItem')
    assert.equal(draft.model.scenarios[0].calls[0].assertions?.[0].expected, '201')
    assert.match(draft.model.scenarios[0].calls[0].body ?? '', /"name":"sample"/)
    assert.equal(draft.model.scenarios[0].calls[1].path, '/api/items/${id}')
    assert.equal(draft.model.scenarios[0].calls[0].extractors?.[0].expression, '$.id')
  })

  it('reads a Postman collection with absolute URLs', async () => {
    const draft = await intakeOpenApi({
      info: {
        name: 'Local collection',
        schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json'
      },
      item: [
        {
          name: 'Health',
          request: {
            method: 'GET',
            url: 'http://127.0.0.1:4010/health'
          }
        }
      ]
    }, config)
    assert.equal(draft.model.scenarios[0].calls[0].path, '/health')
    assert.equal(draft.model.baseUrl, 'http://127.0.0.1:4010')
  })

  it('refuses an OpenAPI server that is not on the allowlist', async () => {
    await assert.rejects(() => intakeOpenApi({
      openapi: '3.0.3',
      info: { title: 'Remote', version: '1.0.0' },
      servers: [{ url: 'https://example.com' }],
      paths: { '/health': { get: { responses: { '200': { description: 'ok' } } } } }
    }, config), TargetNotAllowedError)
  })

  it('correlates a token from a HAR response into the next request', () => {
    const draft = intakeHar({
      log: {
        entries: [
          {
            pageref: 'login',
            request: { method: 'POST', url: 'http://127.0.0.1:4010/login', postData: { text: '{"user":"ada"}', mimeType: 'application/json' } },
            response: { status: 200, content: { mimeType: 'application/json', text: JSON.stringify({ token: 'abcdefghijk' }) } }
          },
          {
            pageref: 'login',
            request: {
              method: 'GET',
              url: 'http://127.0.0.1:4010/profile',
              headers: [{ name: 'Authorization', value: 'Bearer abcdefghijk' }]
            },
            response: { status: 200, content: { mimeType: 'application/json', text: '{"ok":true}' } }
          },
          {
            request: { method: 'GET', url: 'http://127.0.0.1:4010/app.js' },
            response: { status: 200, content: { mimeType: 'application/javascript', text: '' } }
          },
          {
            request: { method: 'GET', url: 'https://www.google-analytics.com/collect' },
            response: { status: 204, content: { mimeType: 'text/plain', text: '' } }
          }
        ]
      }
    }, config)

    assert.equal(draft.model.scenarios.length, 1)
    const login = draft.model.scenarios[0].calls[0]
    const profile = draft.model.scenarios[0].calls[1]
    assert.equal(login.extractors?.[0].name, 'token')
    assert.equal(login.extractors?.[0].expression, '$.token')
    assert.equal(profile.headers?.Authorization, undefined)
    assert.equal(draft.model.auth?.type, 'bearer')
    assert.equal(draft.model.scenarios[0].calls.length, 2)
  })

  it('splits journey steps and refuses a host that is not allowed', async () => {
    assert.deepEqual(splitSteps('open /health then click Login'), ['open /health', 'click Login'])
    const dir = await mkdtemp(join(tmpdir(), 'journey-'))
    await assert.rejects(() => intakeJourney({ url: 'https://example.com', steps: 'click Login' }, config, dir), TargetNotAllowedError)
  })
})
