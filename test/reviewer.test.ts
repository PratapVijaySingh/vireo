import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { reviewRun } from '../src/agents/reviewer'
import { acceptReviewerPatch } from '../src/agents/safety'
import { emptyMetrics, type RunMetrics } from '../src/jmeter/results'
import type { TestPlanModel } from '../src/model/test-plan'
import { sampler, testConfig } from './helpers'

const config = testConfig('data/unused')

function plan(): TestPlanModel {
  return {
    name: 'Local',
    baseUrl: 'http://127.0.0.1:4010',
    auth: { type: 'none' },
    scenarios: [{
      name: 'API',
      calls: [{
        name: 'createItem',
        method: 'POST',
        path: '/items',
        body: '{"name":"Ada"}',
        assertions: [{ type: 'status', expected: '200' }]
      }]
    }],
    load: { threads: 2, rampUpSec: 1, durationSec: 30 },
    goal: { p95Ms: 500, errorRatePct: 1 }
  }
}

function metrics(partial: Partial<RunMetrics>): RunMetrics {
  return { ...emptyMetrics(), ...partial }
}

describe('reviewer', () => {
  it('treats zero samples as a script defect', () => {
    const decision = reviewRun(plan(), metrics({ total: null }))
    assert.equal(decision.verdict, 'script_defect')
    assert.equal(decision.patch, null)
  })

  it('asks for credentials when the server returns 401', () => {
    const decision = reviewRun(plan(), metrics({
      total: sampler({ transaction: 'Total', sampleCount: 4, errorCount: 4, errorPct: 100 }),
      responseCodes: { '401': 4 },
      codesByLabel: { createItem: { '401': 4 } }
    }))
    assert.equal(decision.verdict, 'script_defect')
    assert.equal(decision.questions[0]?.id, 'token')
    assert.equal(decision.patch, null)
  })

  it('corrects a status assertion to the 2xx code the server actually returned', () => {
    const decision = reviewRun(plan(), metrics({
      total: sampler({ transaction: 'Total', sampleCount: 4, errorCount: 4, errorPct: 100 }),
      responseCodes: { '201': 4 },
      codesByLabel: { createItem: { '201': 4 } },
      samplers: [sampler({ transaction: 'createItem', sampleCount: 4, errorCount: 4, errorPct: 100 })]
    }))
    assert.equal(decision.verdict, 'script_defect')
    assert.equal(decision.patch?.scenarios[0].calls[0].assertions?.[0].expected, '201')
  })

  it('reports server errors as a performance finding and does not weaken the test', () => {
    const decision = reviewRun(plan(), metrics({
      total: sampler({ transaction: 'Total', sampleCount: 10, errorCount: 8, errorPct: 80, pct2ResTime: 900 }),
      responseCodes: { '500': 8, '200': 2 },
      codesByLabel: { createItem: { '500': 8, '200': 2 } },
      samplers: [sampler({ transaction: 'createItem', sampleCount: 10, errorCount: 8, errorPct: 80, pct2ResTime: 900 })]
    }))
    assert.equal(decision.verdict, 'performance_finding')
    assert.equal(decision.patch, null)
  })

  it('reports a missed latency goal without changing the scenario', () => {
    const decision = reviewRun(plan(), metrics({
      total: sampler({ transaction: 'Total', sampleCount: 10, errorCount: 0, errorPct: 0, pct2ResTime: 800 }),
      responseCodes: { '200': 10 },
      samplers: [sampler({ transaction: 'createItem', sampleCount: 10, pct2ResTime: 800 })]
    }))
    assert.equal(decision.verdict, 'performance_finding')
    assert.match(decision.reason, /800ms/)
    assert.equal(decision.patch, null)
  })

  it('meets the goal when error rate and p95 are inside the budget', () => {
    const decision = reviewRun(plan(), metrics({
      total: sampler({ transaction: 'Total', sampleCount: 10, errorCount: 0, errorPct: 0, pct2ResTime: 40 }),
      responseCodes: { '200': 10 }
    }))
    assert.equal(decision.verdict, 'goal_met')
  })

  it('rejects a review patch that deletes a call or loosens the goal', () => {
    const original = plan()
    const proposed = structuredClone(original)
    proposed.scenarios[0].calls = [{
      name: 'other',
      method: 'GET',
      path: '/health',
      assertions: [{ type: 'status', expected: '200' }]
    }]
    proposed.goal = { p95Ms: 5000, errorRatePct: 50 }
    const accepted = acceptReviewerPatch(original, proposed, config)
    assert.equal(accepted.ok, false)
    assert.equal(accepted.model.scenarios[0].calls[0].name, 'createItem')
  })
})
