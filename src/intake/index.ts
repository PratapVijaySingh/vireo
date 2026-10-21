import type { AppConfig } from '../config'
import type { JobSource } from '../model/job'
import { intakeHar, type IntakeDraft } from './har'
import { intakeJourney } from './journey'
import { intakeOpenApi } from './openapi'

export type { IntakeDraft }

export function coercePayload(payload: unknown): unknown {
  if (typeof payload !== 'string') return payload
  const trimmed = payload.trim()
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
    throw new Error('payload string must be JSON')
  }
  return JSON.parse(trimmed) as unknown
}

export async function intakeSource(source: JobSource, payload: unknown, config: AppConfig, workDir: string): Promise<IntakeDraft> {
  const document = coercePayload(payload)
  if (source === 'openapi') return intakeOpenApi(document, config)
  if (source === 'har') return intakeHar(document, config)
  if (source === 'journey') {
    const request = document as { url?: string; steps?: string }
    if (!request || typeof request.url !== 'string') throw new Error('journey payload requires a url')
    return intakeJourney({ url: request.url, steps: request.steps }, config, workDir)
  }
  throw new Error(`Unknown source ${source}`)
}
