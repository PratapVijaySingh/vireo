import { z } from 'zod'
import type { AppConfig } from '../config'

export const extractorSchema = z.object({
  name: z.string().min(1),
  source: z.enum(['json', 'regex']),
  expression: z.string().min(1),
  matchNumber: z.number().int().positive().optional(),
  defaultValue: z.string().optional()
})

export const assertionSchema = z.object({
  type: z.enum(['status', 'json', 'text']),
  expected: z.string().min(1),
  jsonPath: z.string().optional()
})

export const httpCallSchema = z.object({
  name: z.string().min(1),
  method: z.string().min(1),
  path: z.string().min(1),
  headers: z.record(z.string(), z.string()).optional(),
  body: z.string().optional(),
  contentType: z.string().optional(),
  thinkTimeMs: z.number().int().nonnegative().optional(),
  extractors: z.array(extractorSchema).optional(),
  assertions: z.array(assertionSchema).optional(),
  requiresBody: z.boolean().optional()
})

export const scenarioSchema = z.object({
  name: z.string().min(1),
  calls: z.array(httpCallSchema).min(1)
})

export const authSchema = z.object({
  type: z.enum(['none', 'basic', 'bearer']),
  username: z.string().optional(),
  password: z.string().optional(),
  token: z.string().optional(),
  tokenVar: z.string().optional(),
  headerName: z.string().optional(),
  headerPrefix: z.string().optional()
})

export const testPlanSchema = z.object({
  name: z.string().min(1),
  baseUrl: z.string().url(),
  auth: authSchema.optional(),
  scenarios: z.array(scenarioSchema).min(1),
  load: z.object({
    threads: z.number().int().positive(),
    rampUpSec: z.number().int().nonnegative(),
    durationSec: z.number().int().positive()
  }),
  goal: z.object({
    p95Ms: z.number().positive().optional(),
    errorRatePct: z.number().nonnegative().optional()
  }).optional()
})

export type Extractor = z.infer<typeof extractorSchema>
export type Assertion = z.infer<typeof assertionSchema>
export type HttpCall = z.infer<typeof httpCallSchema>
export type Scenario = z.infer<typeof scenarioSchema>
export type Auth = z.infer<typeof authSchema>
export type TestPlanModel = z.infer<typeof testPlanSchema>

export interface Question {
  id: string
  prompt: string
}

export function parseTestPlan(input: unknown): TestPlanModel {
  return testPlanSchema.parse(input)
}

export function callNames(model: TestPlanModel): string[] {
  return model.scenarios.flatMap((scenario) => scenario.calls.map((call) => call.name))
}

export function findCall(model: TestPlanModel, name: string): HttpCall | undefined {
  for (const scenario of model.scenarios) {
    const call = scenario.calls.find((item) => item.name === name)
    if (call) return call
  }
  return undefined
}

export function clampLoad(model: TestPlanModel, config: AppConfig): string[] {
  const notes: string[] = []
  const requestedThreads = model.load?.threads
  const requestedDuration = model.load?.durationSec
  const requestedRamp = model.load?.rampUpSec
  const threads = requestedThreads ?? config.defaultThreads
  const duration = requestedDuration ?? config.defaultDurationSec
  const ramp = requestedRamp ?? config.defaultRampUpSec
  const clampedThreads = Math.min(config.maxThreads, Math.max(1, Math.floor(threads)))
  const clampedDuration = Math.min(config.maxDurationSec, Math.max(1, Math.floor(duration)))
  const clampedRamp = Math.min(clampedDuration, Math.max(0, Math.floor(ramp)))

  if (requestedThreads != null && clampedThreads !== Math.floor(requestedThreads)) {
    notes.push(`threads clamped from ${requestedThreads} to ${clampedThreads}`)
  }
  if (requestedDuration != null && clampedDuration !== Math.floor(requestedDuration)) {
    notes.push(`durationSec clamped from ${requestedDuration} to ${clampedDuration}`)
  }

  model.load = {
    threads: clampedThreads,
    rampUpSec: clampedRamp,
    durationSec: clampedDuration
  }
  return notes
}

export function defaultLoad(config: AppConfig): TestPlanModel['load'] {
  return {
    threads: Math.min(config.defaultThreads, config.maxThreads),
    rampUpSec: Math.min(config.defaultRampUpSec, config.maxDurationSec),
    durationSec: Math.min(config.defaultDurationSec, config.maxDurationSec)
  }
}

export function hasGoal(model: TestPlanModel): boolean {
  const p95 = model.goal?.p95Ms
  const errors = model.goal?.errorRatePct
  return (typeof p95 === 'number' && Number.isFinite(p95)) || (typeof errors === 'number' && Number.isFinite(errors))
}

const SECRET_ECHO = '${provided}'

export function redactModel(model: TestPlanModel): TestPlanModel {
  const copy = structuredClone(model)
  if (copy.auth?.token) copy.auth.token = SECRET_ECHO
  if (copy.auth?.password) copy.auth.password = SECRET_ECHO
  return copy
}

export function restoreSecrets(original: TestPlanModel, proposed: TestPlanModel): string[] {
  const rejected: string[] = []
  if (!proposed.auth) return rejected
  const originalToken = original.auth?.token
  const originalPassword = original.auth?.password

  if (proposed.auth.token && proposed.auth.token !== SECRET_ECHO && proposed.auth.token !== originalToken) {
    rejected.push('refusing invented credentials')
    proposed.auth.token = originalToken
  } else if (proposed.auth.token === SECRET_ECHO || proposed.auth.token == null) {
    proposed.auth.token = originalToken
  }

  if (proposed.auth.password && proposed.auth.password !== SECRET_ECHO && proposed.auth.password !== originalPassword) {
    rejected.push('refusing invented credentials')
    proposed.auth.password = originalPassword
  } else if (proposed.auth.password === SECRET_ECHO || proposed.auth.password == null) {
    proposed.auth.password = originalPassword
  }

  return rejected
}

export function uniqueName(existing: Set<string>, name: string): string {
  const base = name.replace(/\s+/g, ' ').trim().slice(0, 110) || 'request'
  let next = base
  let index = 2
  while (existing.has(next)) {
    next = `${base} ${index}`
    index += 1
  }
  existing.add(next)
  return next
}
