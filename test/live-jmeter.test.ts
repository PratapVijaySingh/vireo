import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { describe, it } from 'node:test'
import { createApp } from '../src/app'
import { testConfig } from './helpers'

const jmeterBin = process.env.JMETER_BIN || ''

describe('live JMeter run', { skip: jmeterBin === '' ? 'JMETER_BIN is not set' : false }, () => {
  it('generates a script and runs it against a local server', async () => {
    const target = createServer((request, response) => {
      if (request.url === '/health') {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ ok: true }))
        return
      }
      response.writeHead(404)
      response.end()
    })
    await listen(target)
    const address = target.address() as AddressInfo
    const dir = await mkdtemp(join(tmpdir(), 'live-jmeter-'))
    const app = createApp({
      config: testConfig(dir, {
        jmeterBin,
        defaultThreads: 1,
        defaultDurationSec: 3,
        defaultRampUpSec: 0,
        maxIterations: 1
      })
    })
    try {
      const created = await app.service('jobs').create({
        source: 'openapi',
        goal: { p95Ms: 2000, errorRatePct: 1 },
        load: { threads: 1, rampUpSec: 0, durationSec: 3 },
        payload: {
          openapi: '3.0.3',
          info: { title: 'Live', version: '1.0.0' },
          servers: [{ url: `http://127.0.0.1:${address.port}` }],
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
      const finished = await waitFor(async () => {
        const job = await app.service('jobs').get(created.id)
        if (job.status === 'completed' || job.status === 'failed') return job
        return undefined
      })
      assert.equal(finished.error, null, finished.reason ?? undefined)
      assert.equal(finished.verdict, 'goal_met')
      assert.ok((finished.history[0]?.metrics?.total?.sampleCount ?? 0) > 0)
    } finally {
      target.closeAllConnections()
      await new Promise<void>((resolve) => target.close(() => resolve()))
      await rm(dir, { recursive: true, force: true })
    }
  })
})

function listen(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve())
  })
}

async function waitFor<T>(read: () => Promise<T | undefined>): Promise<T> {
  const started = Date.now()
  while (Date.now() - started < 180000) {
    const value = await read()
    if (value) return value
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  throw new Error('timed out waiting for JMeter')
}
