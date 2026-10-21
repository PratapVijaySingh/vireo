import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { buildJmx } from '../src/jmeter/jmx-builder'
import { testConfig } from './helpers'
import type { TestPlanModel } from '../src/model/test-plan'

const config = testConfig('data/unused')

function plan(overrides: Partial<TestPlanModel> = {}): TestPlanModel {
  return {
    name: 'Local API',
    baseUrl: 'http://127.0.0.1:4010',
    auth: { type: 'bearer', token: 'secret-token', tokenVar: 'token' },
    scenarios: [
      {
        name: 'Health scenario',
        calls: [
          {
            name: 'GET /health',
            method: 'GET',
            path: '/health',
            thinkTimeMs: 200,
            extractors: [{ name: 'token', source: 'json', expression: '$.token', matchNumber: 1, defaultValue: 'NOT_FOUND' }],
            assertions: [
              { type: 'status', expected: '200' },
              { type: 'json', expected: 'true', jsonPath: '$.ok' },
              { type: 'text', expected: 'ok' }
            ]
          },
          {
            name: 'A & B <tag>',
            method: 'POST',
            path: '/pets',
            body: '{"name":"Ada"}',
            headers: { 'X-Trace': '1' }
          }
        ]
      }
    ],
    load: { threads: config.defaultThreads, rampUpSec: 1, durationSec: 30 },
    goal: { p95Ms: 500, errorRatePct: 1 },
    ...overrides
  }
}

describe('JMX builder', () => {
  it('writes a stock JMeter 5.6 plan with the scenario samplers', () => {
    const xml = buildJmx(plan())
    assert.match(xml, /<ThreadGroup /)
    assert.match(xml, /testname="Health scenario"/)
    assert.match(xml, /testname="GET \/health"/)
    assert.match(xml, /<HTTPSamplerProxy /)
    assert.match(xml, /HTTP Cookie Manager/)
    assert.match(xml, /HTTP Request Defaults/)
    assert.match(xml, /<TransactionController /)
    assert.match(xml, /<JSONPostProcessor /)
    assert.match(xml, /JSONPostProcessor.jsonPathExprs">\$\.token/)
    assert.match(xml, /Assertion.response_code/)
    assert.match(xml, /<JMESPathAssertion /)
    assert.match(xml, /JMES_PATH">ok/)
    assert.match(xml, /ConstantTimer/)
    assert.match(xml, /Bearer \$\{token\}/)
    assert.match(xml, /secret-token/)
    assert.match(xml, /testname="A &amp; B &lt;tag&gt;"/)
    assert.match(xml, /HTTPSampler.postBodyRaw">true/)
    assert.equal((xml.match(/<hashTree>/g) ?? []).length, (xml.match(/<\/hashTree>/g) ?? []).length)
  })

  it('disables the thread group when validating so the engine does not send load', () => {
    const xml = buildJmx(plan(), { mode: 'validate' })
    assert.match(xml, /<ThreadGroup [^>]*enabled="false"/)
    assert.match(xml, /ThreadGroup.scheduler">false/)
    assert.match(xml, /LoopController.loops">1/)
  })
})
