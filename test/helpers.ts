import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadConfig, type AppConfig } from '../src/config'
import type { SamplerStats } from '../src/jmeter/results'

export async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'vireo-'))
}

export async function removeDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true })
}

export function testConfig(dataDir: string, overrides: Partial<AppConfig> = {}): AppConfig {
  return loadConfig(process.cwd(), {
    dataDir,
    llmApiKey: '',
    jmeterBin: '',
    allowedHosts: ['127.0.0.1', 'localhost'],
    maxThreads: 20,
    maxDurationSec: 120,
    defaultThreads: 5,
    defaultDurationSec: 60,
    defaultRampUpSec: 5,
    maxIterations: 3,
    ...overrides
  })
}

export function sampler(partial: Partial<SamplerStats> & Pick<SamplerStats, 'transaction'>): SamplerStats {
  return {
    sampleCount: 1,
    errorCount: 0,
    errorPct: 0,
    meanResTime: 10,
    minResTime: 5,
    maxResTime: 20,
    pct1ResTime: 15,
    pct2ResTime: 18,
    pct3ResTime: 20,
    throughput: 1,
    ...partial
  }
}
