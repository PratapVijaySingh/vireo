import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { LLM_PROVIDERS, providerById, type StoredLlmProvider } from './agents/providers'

export interface AppConfig {
  host: string
  port: number
  jmeterBin: string
  llmBaseUrl: string
  llmModel: string
  llmApiKey: string
  llmApiVersion: string
  llmActive: string
  llmEnvKey: string
  llmProviders: Record<string, StoredLlmProvider>
  rootDir: string
  allowedHosts: string[]
  maxThreads: number
  maxDurationSec: number
  defaultThreads: number
  defaultDurationSec: number
  defaultRampUpSec: number
  maxIterations: number
  dataDir: string
}

interface ConfigFile {
  host: string
  port: number
  jmeterBin?: string
  llmBaseUrl: string
  llmModel: string
  llmApiKey?: string
  llm?: {
    active?: string
    providers?: Record<string, Partial<StoredLlmProvider>>
  }
  allowedHosts: string[]
  maxThreads: number
  maxDurationSec: number
  defaultThreads: number
  defaultDurationSec: number
  defaultRampUpSec: number
  maxIterations: number
  dataDir: string
}

function numberFrom(envValue: string | undefined, fallback: number): number {
  if (envValue == null || envValue.trim() === '') return fallback
  const parsed = Number(envValue)
  if (!Number.isFinite(parsed)) return fallback
  return parsed
}

function readOptionalConfig(path: string): Partial<ConfigFile> {
  if (!existsSync(path)) return {}
  return JSON.parse(readFileSync(path, 'utf8')) as Partial<ConfigFile>
}

function hostList(entries: string[] | undefined): string[] {
  return (entries ?? []).map((entry) => entry.trim()).filter(Boolean)
}

export function loadConfig(cwd = process.cwd(), overrides: Partial<AppConfig> = {}): AppConfig {
  const file = JSON.parse(readFileSync(resolve(cwd, 'config/default.json'), 'utf8')) as ConfigFile
  const local = readOptionalConfig(resolve(cwd, 'config/local.json'))
  const fromFiles = [...new Set([...hostList(file.allowedHosts), ...hostList(local.allowedHosts)])]
  const allowed = process.env.ALLOWED_HOSTS
    ? hostList(process.env.ALLOWED_HOSTS.split(','))
    : fromFiles

  const llmProviders = readStoredProviders(local.llm?.providers)
  const llmEnvKey = process.env.LLM_API_KEY || ''
  const requestedActive = local.llm?.active || 'openai'
  const llmActive = providerById(requestedActive) ? requestedActive : 'openai'
  const resolved = resolveLlm(llmActive, llmProviders, {
    apiKey: llmEnvKey || file.llmApiKey || '',
    baseUrl: process.env.LLM_BASE_URL || file.llmBaseUrl,
    model: process.env.LLM_MODEL || file.llmModel
  })

  const config: AppConfig = {
    host: process.env.HOST || file.host,
    port: numberFrom(process.env.PORT, file.port),
    jmeterBin: process.env.JMETER_BIN || file.jmeterBin || '',
    llmBaseUrl: resolved.baseUrl,
    llmModel: resolved.model,
    llmApiKey: resolved.apiKey,
    llmApiVersion: resolved.apiVersion,
    llmActive,
    llmEnvKey,
    llmProviders,
    rootDir: cwd,
    allowedHosts: allowed,
    maxThreads: numberFrom(process.env.MAX_THREADS, file.maxThreads),
    maxDurationSec: numberFrom(process.env.MAX_DURATION_SEC, file.maxDurationSec),
    defaultThreads: file.defaultThreads,
    defaultDurationSec: file.defaultDurationSec,
    defaultRampUpSec: file.defaultRampUpSec,
    maxIterations: file.maxIterations,
    dataDir: process.env.DATA_DIR || file.dataDir
  }

  return { ...config, ...overrides }
}

export interface LlmSaveInput {
  id: string
  apiKey?: string
  model?: string
  baseUrl?: string
  apiVersion?: string
}

export function saveLlmProvider(config: AppConfig, input: LlmSaveInput): void {
  const preset = providerById(input.id)
  if (!preset) throw new Error('Choose a provider from the list')
  const previous = config.llmProviders[preset.id]
  const apiKey = input.apiKey?.trim() ? input.apiKey.trim() : (previous?.apiKey || (preset.id === 'openai' ? config.llmEnvKey : ''))
  const model = input.model?.trim() || previous?.model || preset.defaultModel
  const baseUrl = (input.baseUrl?.trim() || previous?.baseUrl || preset.defaultBaseUrl).replace(/\/$/, '')
  const apiVersion = input.apiVersion?.trim() || previous?.apiVersion || preset.defaultApiVersion
  if (!apiKey && !preset.keyOptional) throw new Error(`Enter an API key for ${preset.label}.`)
  if (!model) throw new Error(`Enter a model name for ${preset.label}.`)
  if (preset.endpoint === 'required' && !baseUrl) throw new Error(`Enter the endpoint for ${preset.label}.`)

  config.llmProviders[preset.id] = { apiKey, model, baseUrl, apiVersion }
  config.llmActive = preset.id
  const resolved = resolveLlm(preset.id, config.llmProviders, {
    apiKey: config.llmEnvKey,
    baseUrl: config.llmBaseUrl,
    model: config.llmModel
  })
  config.llmApiKey = resolved.apiKey
  config.llmBaseUrl = resolved.baseUrl
  config.llmModel = resolved.model
  config.llmApiVersion = resolved.apiVersion
  writeLocalLlm(config)
}

function readStoredProviders(raw: Record<string, Partial<StoredLlmProvider>> | undefined): Record<string, StoredLlmProvider> {
  const providers: Record<string, StoredLlmProvider> = {}
  for (const preset of LLM_PROVIDERS) {
    const saved = raw?.[preset.id]
    if (!saved) continue
    providers[preset.id] = {
      apiKey: typeof saved.apiKey === 'string' ? saved.apiKey : '',
      model: typeof saved.model === 'string' ? saved.model : '',
      baseUrl: typeof saved.baseUrl === 'string' ? saved.baseUrl : '',
      apiVersion: typeof saved.apiVersion === 'string' ? saved.apiVersion : ''
    }
  }
  return providers
}

function resolveLlm(active: string, providers: Record<string, StoredLlmProvider>, fallback: { apiKey: string; baseUrl: string; model: string }): StoredLlmProvider {
  const preset = providerById(active) ?? LLM_PROVIDERS[0]
  const saved = providers[preset.id]
  const apiKey = saved?.apiKey || (preset.id === 'openai' ? fallback.apiKey : '')
  return {
    apiKey,
    model: saved?.model || preset.defaultModel || fallback.model,
    baseUrl: (saved?.baseUrl || preset.defaultBaseUrl || fallback.baseUrl).replace(/\/$/, ''),
    apiVersion: saved?.apiVersion || preset.defaultApiVersion
  }
}

function writeLocalLlm(config: AppConfig): void {
  const path = resolve(config.rootDir, 'config/local.json')
  const current = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown> : {}
  const providers: Record<string, StoredLlmProvider> = {}
  for (const [id, saved] of Object.entries(config.llmProviders)) {
    if (!saved.apiKey && !saved.model && !saved.baseUrl) continue
    providers[id] = saved
  }
  current.llm = { active: config.llmActive, providers }
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(current, null, 2)}\n`)
}
