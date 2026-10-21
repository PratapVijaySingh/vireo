import type { Context, Next } from 'koa'
import { saveLlmProvider, type AppConfig } from '../config'
import { LLM_PROVIDERS, providerById, type LlmProviderPreset, type StoredLlmProvider } from '../agents/providers'

export function publicLlm(config: AppConfig) {
  return {
    active: config.llmActive,
    providers: configProviders(config)
  }
}

export function llmMiddleware(config: AppConfig) {
  return async (ctx: Context, next: Next) => {
    if (ctx.path !== '/llm') {
      await next()
      return
    }
    if (ctx.method === 'GET') {
      ctx.body = publicLlm(config)
      return
    }
    if (ctx.method !== 'POST') {
      await next()
      return
    }
    try {
      saveLlmProvider(config, readSaveBody(ctx.request.body))
      ctx.body = publicLlm(config)
    } catch (error) {
      ctx.status = 400
      ctx.body = { message: error instanceof Error ? error.message : 'Could not save the provider' }
    }
  }
}

function configProviders(config: AppConfig) {
  return LLM_PROVIDERS.map((preset) => {
    const saved = config.llmProviders[preset.id]
    return {
      id: preset.id,
      label: preset.label,
      protocol: preset.protocol,
      endpoint: preset.endpoint,
      keyOptional: Boolean(preset.keyOptional),
      defaultModel: preset.defaultModel,
      defaultBaseUrl: preset.defaultBaseUrl,
      defaultApiVersion: preset.defaultApiVersion,
      model: saved?.model || preset.defaultModel,
      baseUrl: saved?.baseUrl || preset.defaultBaseUrl,
      apiVersion: saved?.apiVersion || preset.defaultApiVersion,
      hasKey: keySource(config, preset, saved) !== 'none',
      keySource: keySource(config, preset, saved)
    }
  })
}

function keySource(config: AppConfig, preset: LlmProviderPreset, saved: StoredLlmProvider | undefined): 'saved' | 'environment' | 'none' {
  if (saved?.apiKey) return 'saved'
  if (preset.id === 'openai' && config.llmActive === 'openai' && config.llmEnvKey) return 'environment'
  return 'none'
}

function readSaveBody(body: unknown): { id: string; apiKey?: string; model?: string; baseUrl?: string; apiVersion?: string } {
  if (!body || typeof body !== 'object') throw new Error('Provider details must be a JSON object')
  const record = body as Record<string, unknown>
  const id = typeof record.id === 'string' ? record.id : ''
  if (!providerById(id)) throw new Error('Choose a provider from the list')
  return {
    id,
    apiKey: typeof record.apiKey === 'string' ? record.apiKey : undefined,
    model: typeof record.model === 'string' ? record.model : undefined,
    baseUrl: typeof record.baseUrl === 'string' ? record.baseUrl : undefined,
    apiVersion: typeof record.apiVersion === 'string' ? record.apiVersion : undefined
  }
}
