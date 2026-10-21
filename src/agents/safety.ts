import type { AppConfig } from '../config'
import type { RunMetrics } from '../jmeter/results'
import {
  callNames,
  clampLoad,
  findCall,
  parseTestPlan,
  restoreSecrets,
  type TestPlanModel
} from '../model/test-plan'
import { assertAllowedUrl, originOf } from '../security/allowlist'

export interface AcceptedPlan {
  ok: boolean
  model: TestPlanModel
  rejected: string[]
  notes: string[]
}

export function acceptPlannerModel(original: TestPlanModel, proposed: unknown, config: AppConfig): AcceptedPlan {
  const rejected: string[] = []
  let model: TestPlanModel
  try {
    model = parseTestPlan(proposed)
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    return { ok: false, model: original, rejected: [`planner model failed validation: ${reason}`], notes: [] }
  }

  if (originOf(model.baseUrl) !== originOf(original.baseUrl)) {
    rejected.push('refusing to change target host')
    model.baseUrl = original.baseUrl
  }
  try {
    assertAllowedUrl(model.baseUrl, config.allowedHosts)
  } catch (error) {
    rejected.push(error instanceof Error ? error.message : String(error))
    model.baseUrl = original.baseUrl
  }

  rejected.push(...restoreSecrets(original, model))
  for (const scenario of model.scenarios) {
    for (const call of scenario.calls) {
      if (/^https?:\/\//i.test(call.path)) {
        rejected.push(`refusing absolute path on ${call.name}`)
        return { ok: false, model: original, rejected, notes: [] }
      }
    }
  }

  const notes = clampLoad(model, config)
  if (callNames(model).length === 0) {
    return { ok: false, model: original, rejected: ['planner removed every call'], notes }
  }
  return { ok: rejected.length === 0, model, rejected, notes }
}

export function acceptReviewerPatch(original: TestPlanModel, proposed: unknown, config: AppConfig): AcceptedPlan {
  const planned = acceptPlannerModel(original, proposed, config)
  if (!planned.ok && planned.model === original) return planned

  const rejected = [...planned.rejected]
  const model = planned.model
  const originalNames = callNames(original)
  const nextNames = new Set(callNames(model))
  for (const name of originalNames) {
    if (!nextNames.has(name)) rejected.push(`refusing to remove call ${name}`)
  }

  for (const name of originalNames) {
    const before = findCall(original, name)
    const after = findCall(model, name)
    if (!before || !after) continue
    const beforeCount = before.assertions?.length ?? 0
    const afterCount = after.assertions?.length ?? 0
    if (afterCount < beforeCount) rejected.push(`refusing to drop assertions on ${name}`)
  }

  if (loadChanged(original, model)) rejected.push('refusing to change load during review')
  if (goalLoosened(original, model)) rejected.push('refusing to loosen the goal during review')
  if (originOf(model.baseUrl) !== originOf(original.baseUrl)) rejected.push('refusing to change target host')

  if (rejected.length > 0) return { ok: false, model: original, rejected, notes: planned.notes }
  return { ok: true, model, rejected, notes: planned.notes }
}

function loadChanged(original: TestPlanModel, next: TestPlanModel): boolean {
  return original.load.threads !== next.load.threads
    || original.load.rampUpSec !== next.load.rampUpSec
    || original.load.durationSec !== next.load.durationSec
}

function goalLoosened(original: TestPlanModel, next: TestPlanModel): boolean {
  const beforeP95 = original.goal?.p95Ms
  const afterP95 = next.goal?.p95Ms
  if (beforeP95 != null && (afterP95 == null || afterP95 > beforeP95)) return true
  const beforeErrors = original.goal?.errorRatePct
  const afterErrors = next.goal?.errorRatePct
  if (beforeErrors != null && (afterErrors == null || afterErrors > beforeErrors)) return true
  return false
}

export function suggestScriptPatch(model: TestPlanModel, metrics: RunMetrics): TestPlanModel | null {
  const next = structuredClone(model)
  let changed = false
  for (const scenario of next.scenarios) {
    for (const call of scenario.calls) {
      if (/(?<!\$)\{[A-Za-z0-9_]+\}/.test(call.path)) {
        call.path = call.path.replace(/(?<!\$)\{([A-Za-z0-9_]+)\}/g, (_match, name: string) => `\${${name}}`)
        changed = true
      }
      const codes = metrics.codesByLabel[call.name] ?? {}
      const codeKeys = Object.keys(codes)
      const statusAssertion = call.assertions?.find((item) => item.type === 'status')
      if (statusAssertion && codeKeys.length === 1 && /^2\d\d$/.test(codeKeys[0]) && statusAssertion.expected !== codeKeys[0]) {
        statusAssertion.expected = codeKeys[0]
        changed = true
      }
    }
  }
  return changed ? next : null
}
