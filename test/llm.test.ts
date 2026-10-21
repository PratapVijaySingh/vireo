import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { createApp } from '../src/app'
import { anthropicMessagesUrl, azureChatUrl, chatCompletionsUrl, geminiGenerateUrl } from '../src/agents/providers'
import { testConfig } from './helpers'

describe('llm providers', () => {
  it('builds provider endpoints', () => {
    assert.equal(chatCompletionsUrl('https://api.openai.com/v1'), 'https://api.openai.com/v1/chat/completions')
    assert.equal(
      azureChatUrl('https://example.openai.azure.com', 'gpt-4o-mini', '2024-10-21'),
      'https://example.openai.azure.com/openai/deployments/gpt-4o-mini/chat/completions?api-version=2024-10-21'
    )
    assert.equal(anthropicMessagesUrl('https://api.anthropic.com'), 'https://api.anthropic.com/v1/messages')
    assert.equal(
      geminiGenerateUrl('https://generativelanguage.googleapis.com/v1beta', 'gemini-2.5-flash'),
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent'
    )
  })

  describe('saved keys', () => {
    let dir = ''
    let base = ''
    let closeServer: (() => Promise<void>) | undefined

    before(async () => {
      dir = await mkdtemp(join(tmpdir(), 'llm-'))
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

    it('stores a provider key locally and does not echo it', async () => {
      const secret = 'sk-test-claude-secret'
      const saved = await fetch(`${base}/llm`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: 'anthropic', apiKey: secret, model: 'claude-sonnet-4-5' })
      })
      assert.equal(saved.status, 200)
      const body = await saved.json() as { active: string; providers: { id: string; hasKey: boolean; keySource: string }[] }
      assert.equal(body.active, 'anthropic')
      assert.equal(JSON.stringify(body).includes(secret), false)
      assert.equal(body.providers.find((provider) => provider.id === 'anthropic')?.keySource, 'saved')

      const listed = await fetch(`${base}/llm`)
      const again = await listed.json() as { providers: { id: string; hasKey: boolean }[] }
      assert.equal(JSON.stringify(again).includes(secret), false)
      assert.equal(again.providers.find((provider) => provider.id === 'anthropic')?.hasKey, true)

      const workbench = await (await fetch(`${base}/workbench`)).json() as { llmConfigured: boolean; llmLabel: string; llmApiKey?: string }
      assert.equal(workbench.llmConfigured, true)
      assert.equal(workbench.llmLabel, 'Claude')
      assert.equal(workbench.llmApiKey, undefined)

      const kept = await fetch(`${base}/llm`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: 'anthropic', apiKey: '', model: 'claude-sonnet-4-5' })
      })
      const keptBody = await kept.json() as { providers: { id: string; hasKey: boolean }[] }
      assert.equal(keptBody.providers.find((provider) => provider.id === 'anthropic')?.hasKey, true)

      const file = JSON.parse(await readFile(join(dir, 'config/local.json'), 'utf8')) as { llm: { providers: { anthropic: { apiKey: string } } } }
      assert.equal(file.llm.providers.anthropic.apiKey, secret)
    })

    it('asks for a key and an Azure endpoint before saving', async () => {
      const missingKey = await fetch(`${base}/llm`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: 'gemini', apiKey: '' })
      })
      assert.equal(missingKey.status, 400)
      const missingEndpoint = await fetch(`${base}/llm`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: 'azure-openai', apiKey: 'azure-key', model: 'my-deployment' })
      })
      assert.equal(missingEndpoint.status, 400)
      assert.match(await missingEndpoint.text(), /endpoint/i)
    })
  })
})
