import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

export interface AppConfig {
  host: string
  port: number
  jmeterBin: string
  llmBaseUrl: string
  llmModel: string
  llmApiKey: string
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

  const config: AppConfig = {
    host: process.env.HOST || file.host,
    port: numberFrom(process.env.PORT, file.port),
    jmeterBin: process.env.JMETER_BIN || file.jmeterBin || '',
    llmBaseUrl: (process.env.LLM_BASE_URL || file.llmBaseUrl).replace(/\/$/, ''),
    llmModel: process.env.LLM_MODEL || file.llmModel,
    llmApiKey: process.env.LLM_API_KEY || file.llmApiKey || '',
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
