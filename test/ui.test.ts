import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { createApp } from '../src/app'
import { testConfig } from './helpers'

describe('workbench UI', () => {
  let dir = ''
  let base = ''
  let closeServer: (() => Promise<void>) | undefined

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ui-'))
    const app = createApp({ config: testConfig(dir) })
    const server = await app.listen(0)
    const address = server.address() as AddressInfo
    base = `http://127.0.0.1:${address.port}`
    closeServer = () => new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve())
    })
  })

  after(async () => {
    if (closeServer) await closeServer()
    if (dir) await rm(dir, { recursive: true, force: true })
  })

  it('serves the workbench page', async () => {
    const response = await fetch(base)
    assert.equal(response.status, 200)
    const html = await response.text()
    assert.match(html, /Vireo/)
    assert.match(html, /New measurement/)
    assert.match(html, /Claude/)
    assert.match(html, /Azure OpenAI/)
    assert.match(html, /Gemini/)
  })

  it('returns public limits and hides secrets', async () => {
    const response = await fetch(`${base}/workbench`)
    const body = await response.json() as { maxThreads: number; allowedHosts: string[]; llmApiKey?: string }
    assert.equal(body.maxThreads, 20)
    assert.ok(body.allowedHosts.includes('127.0.0.1'))
    assert.equal(body.llmApiKey, undefined)
  })

  it('does not serve a script that has not been written', async () => {
    const response = await fetch(`${base}/files/11111111-1111-4111-8111-111111111111/plan.jmx`)
    assert.equal(response.status, 404)
  })
})
