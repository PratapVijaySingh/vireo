import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { runJob } from '../src/agents/loop'
import type { Engine } from '../src/jmeter/engine'
import { emptyMetrics, type RunMetrics } from '../src/jmeter/results'
import type { JobRecord } from '../src/model/job'
import type { TestPlanModel } from '../src/model/test-plan'
import { sampler, testConfig } from './helpers'

function metrics(partial: Partial<RunMetrics>): RunMetrics {
  return { ...emptyMetrics(), ...partial }
}

function scripted(script: RunMetrics[]): Engine {
  let index = 0
  return {
    async validate() {
      return { mode: 'engine' }
    },
    async run() {
      const next = script[Math.min(index, script.length - 1)]
      index += 1
      return { metrics: next, jtlPath: '' }
    }
  }
}

function model(): TestPlanModel {
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
    load: { threads: 1, rampUpSec: 0, durationSec: 5 },
    goal: { p95Ms: 500, errorRatePct: 1 }
  }
}

describe('generate-run-revise loop', () => {
  it('revises a wrong status assertion and then reports the goal as met', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'loop-'))
    const config = testConfig(dir)
    const created = metrics({
      total: sampler({ transaction: 'Total', sampleCount: 4, errorCount: 4, errorPct: 100, pct2ResTime: 30 }),
      responseCodes: { '201': 4 },
      codesByLabel: { createItem: { '201': 4 } },
      samplers: [sampler({ transaction: 'createItem', sampleCount: 4, errorCount: 4, errorPct: 100, pct2ResTime: 30 })]
    })
    const healthy = metrics({
      total: sampler({ transaction: 'Total', sampleCount: 4, errorCount: 0, errorPct: 0, pct2ResTime: 25 }),
      responseCodes: { '201': 4 },
      codesByLabel: { createItem: { '201': 4 } },
      samplers: [sampler({ transaction: 'createItem', sampleCount: 4, errorCount: 0, errorPct: 0, pct2ResTime: 25 })]
    })
    const job: JobRecord = {
      id: '11111111-1111-4111-8111-111111111111',
      source: 'openapi',
      status: 'intake',
      iteration: 0,
      questions: [],
      verdict: null,
      reason: null,
      error: null,
      notes: [],
      model: model(),
      history: [],
      artifacts: {},
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    }
    const phases: string[] = []
    await runJob(job, config, scripted([created, healthy]), {
      onUpdate: (current) => {
        phases.push(current.status)
      }
    })
    assert.equal(job.verdict, 'goal_met')
    assert.equal(job.status, 'completed')
    assert.equal(job.history.length, 2)
    assert.equal(job.history[0].verdict, 'script_defect')
    assert.equal(job.history[0].patched, true)
    assert.equal(job.model?.scenarios[0].calls[0].assertions?.[0].expected, '201')
    assert.ok(phases.includes('planning'))
    assert.ok(phases.includes('running'))
    assert.ok(phases.includes('reviewing'))
    await rm(dir, { recursive: true, force: true })
  })

  it('stops with a performance finding instead of deleting the slow call', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'loop-slow-'))
    const config = testConfig(dir)
    const slow = metrics({
      total: sampler({ transaction: 'Total', sampleCount: 6, errorCount: 0, errorPct: 0, pct2ResTime: 900 }),
      responseCodes: { '200': 6 },
      codesByLabel: { createItem: { '200': 6 } },
      samplers: [sampler({ transaction: 'createItem', sampleCount: 6, pct2ResTime: 900 })]
    })
    const job: JobRecord = {
      id: '22222222-2222-4222-8222-222222222222',
      source: 'har',
      status: 'intake',
      iteration: 0,
      questions: [],
      verdict: null,
      reason: null,
      error: null,
      notes: [],
      model: model(),
      history: [],
      artifacts: {},
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    }
    await runJob(job, config, scripted([slow]), { onUpdate: () => undefined })
    assert.equal(job.verdict, 'performance_finding')
    assert.equal(job.history.length, 1)
    assert.equal(job.model?.scenarios[0].calls.length, 1)
    await rm(dir, { recursive: true, force: true })
  })
})
