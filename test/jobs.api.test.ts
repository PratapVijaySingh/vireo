import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { after, before, describe, it } from 'node:test'
import { io, type Socket } from 'socket.io-client'
import { createApp } from '../src/app'
import type { Engine } from '../src/jmeter/engine'
import { emptyMetrics, type RunMetrics } from '../src/jmeter/results'
import { sampler, testConfig } from './helpers'

function metrics(partial: Partial<RunMetrics>): RunMetrics {
  return { ...emptyMetrics(), ...partial }
}

function scripted(): Engine {
  return {
    async validate() {
      return { mode: 'engine' }
    },
    async run() {
      return {
        metrics: metrics({
          total: sampler({ transaction: 'Total', sampleCount: 2, errorCount: 0, errorPct: 0, pct2ResTime: 12 }),
          responseCodes: { '200': 2 },
          codesByLabel: { health: { '200': 2 } },
          samplers: [sampler({ transaction: 'health', sampleCount: 2, pct2ResTime: 12 })]
        }),
        jtlPath: ''
      }
    }
  }
}

describe('jobs API', () => {
  let dir = ''
  let base = ''
  let closeServer: (() => Promise<void>) | undefined
  let socket: Socket | undefined

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'jobs-api-'))
    const app = createApp({ config: testConfig(dir), engine: scripted() })
    const server = await app.listen(0)
    const address = server.address() as AddressInfo
    base = `http://127.0.0.1:${address.port}`
    closeServer = () => new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve())
    })
  })

  after(async () => {
    socket?.close()
    if (closeServer) await closeServer()
    if (dir) await rm(dir, { recursive: true, force: true })
  })

  it('refuses a target that is not on the allowlist', async () => {
    const response = await fetch(`${base}/jobs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        source: 'openapi',
        payload: {
          openapi: '3.0.3',
          info: { title: 'Remote', version: '1.0.0' },
          servers: [{ url: 'https://example.com' }],
          paths: { '/health': { get: { responses: { '200': { description: 'ok' } } } } }
        },
        goal: { errorRatePct: 1 }
      })
    })
    assert.equal(response.status, 400)
    const body = await response.json() as { message: string }
    assert.match(body.message, /ALLOWED_HOSTS/)
  })

  it('creates a job, streams phases, and returns the jmx plus verdict', async () => {
    socket = io(base, { transports: ['websocket'] })
    const phases: string[] = []
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('socket did not connect')), 5000)
      socket?.on('connect', () => {
        clearTimeout(timer)
        resolve()
      })
      socket?.on('connect_error', (error) => {
        clearTimeout(timer)
        reject(error)
      })
    })
    socket.on('jobs status', (payload: { status: string }) => {
      phases.push(payload.status)
    })

    const created = await fetch(`${base}/jobs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        source: 'openapi',
        name: 'Local health',
        goal: { p95Ms: 500, errorRatePct: 1 },
        payload: {
          openapi: '3.0.3',
          info: { title: 'Local health', version: '1.0.0' },
          servers: [{ url: 'http://127.0.0.1:4010' }],
          paths: {
            '/health': {
              get: {
                operationId: 'health',
                responses: { '200': { description: 'ok' } }
              }
            }
          }
        }
      })
    })
    assert.equal(created.status, 201)
    const job = await created.json() as { id: string; model: { auth?: { token?: string } } }
    assert.equal(job.model.auth?.token, undefined)

    const finished = await waitForJob(base, job.id)
    assert.equal(finished.verdict, 'goal_met')
    assert.equal(finished.status, 'completed')
    assert.ok(finished.artifacts.jmx)
    const xml = await readFile(join(dir, job.id, 'plan.jmx'), 'utf8')
    assert.match(xml, /<ThreadGroup /)
    assert.match(xml, /testname="health"/)
    await waitFor(() => phases.includes('running') && phases.includes('reviewing') && phases.includes('completed'))
  })

  it('pauses when the goal is missing and resumes from the answer', async () => {
    const created = await fetch(`${base}/jobs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        source: 'har',
        payload: {
          log: {
            entries: [
              {
                request: { method: 'GET', url: 'http://127.0.0.1:4010/health' },
                response: { status: 200, content: { mimeType: 'application/json', text: '{"ok":true}' } }
              }
            ]
          }
        }
      })
    })
    assert.equal(created.status, 201)
    const waiting = await created.json() as { id: string; status: string; questions: { id: string }[] }
    assert.equal(waiting.status, 'needs_input')
    assert.ok(waiting.questions.some((question) => question.id === 'goal'))

    const resumed = await fetch(`${base}/jobs/${waiting.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ answers: { goal: '{"errorRatePct":5,"p95Ms":800}' } })
    })
    assert.equal(resumed.status, 200)
    const finished = await waitForJob(base, waiting.id)
    assert.equal(finished.verdict, 'goal_met')
  })
})

async function waitForJob(base: string, id: string): Promise<{
  status: string
  verdict: string | null
  artifacts: { jmx?: string }
}> {
  return waitFor(async () => {
    const response = await fetch(`${base}/jobs/${id}`)
    const body = await response.json() as { status: string; verdict: string | null; artifacts: { jmx?: string } }
    if (body.status === 'completed' || body.status === 'failed') return body
    return undefined
  })
}

async function waitFor<T>(read: () => Promise<T | undefined> | T | undefined): Promise<T> {
  const started = Date.now()
  while (Date.now() - started < 8000) {
    const value = await read()
    if (value) return value
    await new Promise((resolve) => setTimeout(resolve, 40))
  }
  throw new Error('timed out waiting for the job')
}
