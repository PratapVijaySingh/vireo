import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { clampLoad, type TestPlanModel } from '../src/model/test-plan'
import { applyAnswers, missingQuestions } from '../src/agents/questions'
import { assertAllowedUrl, TargetNotAllowedError } from '../src/security/allowlist'
import { testConfig } from './helpers'

const config = testConfig('data/unused', { maxThreads: 20, maxDurationSec: 120 })

describe('allowlist and caps', () => {
  it('allows localhost and refuses other hosts, including the metadata address', () => {
    assert.equal(assertAllowedUrl('http://127.0.0.1:4010/health', config.allowedHosts).hostname, '127.0.0.1')
    assert.throws(() => assertAllowedUrl('https://example.com', config.allowedHosts), TargetNotAllowedError)
    assert.throws(() => assertAllowedUrl('http://169.254.169.254/latest', ['169.254.169.254']), TargetNotAllowedError)
    assert.throws(() => assertAllowedUrl('file:///etc/passwd', config.allowedHosts), TargetNotAllowedError)
  })

  it('clamps threads and duration to the configured caps', () => {
    const model = {
      name: 'Cap',
      baseUrl: 'http://127.0.0.1:9',
      scenarios: [{ name: 's', calls: [{ name: 'c', method: 'GET', path: '/' }] }],
      load: { threads: 500, rampUpSec: 1, durationSec: 3600 }
    } as TestPlanModel
    const notes = clampLoad(model, config)
    assert.equal(model.load.threads, 20)
    assert.equal(model.load.durationSec, 120)
    assert.ok(notes.some((note) => note.includes('threads')))
  })

  it('pauses for a goal and a token, then continues once answers arrive', () => {
    const model: TestPlanModel = {
      name: 'Auth',
      baseUrl: 'http://127.0.0.1:9',
      auth: { type: 'bearer', tokenVar: 'token' },
      scenarios: [{ name: 's', calls: [{ name: 'c', method: 'GET', path: '/', requiresBody: false }] }],
      load: { threads: 1, rampUpSec: 0, durationSec: 1 }
    }
    const questions = missingQuestions(model)
    assert.deepEqual(questions.map((question) => question.id), ['token', 'goal'])
    const answered = applyAnswers(model, { token: 'abc', goal: '{"p95Ms":400,"errorRatePct":2}' })
    assert.equal(answered.auth?.token, 'abc')
    assert.equal(answered.goal?.p95Ms, 400)
    assert.equal(missingQuestions(answered).length, 0)
  })
})
