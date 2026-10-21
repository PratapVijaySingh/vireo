import type { AppConfig } from '../config'
import type { RunMetrics, SamplerStats } from '../jmeter/results'
import type { Question, TestPlanModel } from '../model/test-plan'
import { redactModel } from '../model/test-plan'
import type { VerdictName } from '../model/job'
import { completeWithTools } from './llm'
import { acceptReviewerPatch, suggestScriptPatch } from './safety'

export interface ReviewDecision {
  verdict: VerdictName
  reason: string
  patch: TestPlanModel | null
  questions: Question[]
}

export function reviewRun(model: TestPlanModel, metrics: RunMetrics): ReviewDecision {
  const total = metrics.total
  if (!total || total.sampleCount === 0) {
    return {
      verdict: 'script_defect',
      reason: 'No samples were recorded. Check the base URL and that the server is running.',
      patch: null,
      questions: []
    }
  }

  const authErrors = (metrics.responseCodes['401'] ?? 0) + (metrics.responseCodes['403'] ?? 0)
  if (authErrors >= total.sampleCount * 0.5) {
    const hasSecret = Boolean(model.auth?.token || model.auth?.password)
    return {
      verdict: 'script_defect',
      reason: hasSecret
        ? 'Most responses were 401 or 403 even though credentials were provided.'
        : 'Most responses were 401 or 403.',
      patch: null,
      questions: hasSecret ? [] : [{ id: 'token', prompt: 'The server returned 401/403. Provide a bearer token or basic credentials.' }]
    }
  }

  const errorBudget = model.goal?.errorRatePct ?? 1
  const patch = total.errorPct > errorBudget ? suggestScriptPatch(model, metrics) : null
  if (patch) {
    return {
      verdict: 'script_defect',
      reason: 'Sampler status, content type, or path placeholders do not match the responses.',
      patch,
      questions: []
    }
  }

  if (total.errorPct > errorBudget && serverErrorShare(metrics, total) >= 0.5) {
    return {
      verdict: 'performance_finding',
      reason: `Error rate ${round(total.errorPct)}% is above ${errorBudget}% and most failures are server errors. ${slowest(metrics)}`,
      patch: null,
      questions: []
    }
  }

  if (total.errorPct > errorBudget) {
    return {
      verdict: 'script_defect',
      reason: `Error rate ${round(total.errorPct)}% is above ${errorBudget}% and there is no safe script correction that keeps the scenario intact.`,
      patch: null,
      questions: []
    }
  }

  if (model.goal?.p95Ms != null && total.pct2ResTime > model.goal.p95Ms) {
    return {
      verdict: 'performance_finding',
      reason: `p95 ${Math.round(total.pct2ResTime)}ms exceeds ${model.goal.p95Ms}ms. ${slowest(metrics)}`,
      patch: null,
      questions: []
    }
  }

  return {
    verdict: 'goal_met',
    reason: `p95 ${Math.round(total.pct2ResTime)}ms and error rate ${round(total.errorPct)}% are within the goal.`,
    patch: null,
    questions: []
  }
}

export async function refineScriptDefect(
  model: TestPlanModel,
  metrics: RunMetrics,
  decision: ReviewDecision,
  config: AppConfig
): Promise<ReviewDecision> {
  if (decision.verdict !== 'script_defect' || decision.patch || decision.questions.length > 0 || !config.llmApiKey) {
    return decision
  }

  const turn = await completeWithTools(config, [
    {
      role: 'system',
      content: [
        'You repair JMeter test plans after a run.',
        'Call update_test_plan only to fix script defects such as extractors, headers, and path variables.',
        'Do not delete calls, drop assertions, raise timeouts, change the load, or loosen the goal.',
        'Do not invent credentials. If you cannot fix it safely, do not call a tool.'
      ].join(' ')
    },
    {
      role: 'user',
      content: JSON.stringify({
        reason: decision.reason,
        plan: redactModel(model),
        metrics: {
          total: metrics.total,
          samplers: metrics.samplers,
          responseCodes: metrics.responseCodes,
          assertionFailures: metrics.assertionFailures
        }
      })
    }
  ])

  const update = turn.toolCalls.find((call) => call.name === 'update_test_plan')
  const proposed = (update?.arguments as { plan?: unknown } | undefined)?.plan
  if (!proposed) return decision
  const accepted = acceptReviewerPatch(model, proposed, config)
  if (!accepted.ok) {
    return { ...decision, reason: `${decision.reason} ${accepted.rejected.join(' ')}`.trim() }
  }
  return { ...decision, patch: accepted.model, reason: `${decision.reason} Applied a script correction.` }
}

function serverErrorShare(metrics: RunMetrics, total: SamplerStats): number {
  const serverErrors = Object.entries(metrics.responseCodes)
    .filter(([code]) => code.startsWith('5'))
    .reduce((sum, [, count]) => sum + count, 0)
  return total.sampleCount === 0 ? 0 : serverErrors / total.sampleCount
}

function slowest(metrics: RunMetrics): string {
  const rows = [...metrics.samplers].sort((left, right) => right.pct2ResTime - left.pct2ResTime).slice(0, 3)
  if (rows.length === 0) return ''
  return `Slowest: ${rows.map((row) => `${row.transaction} p95 ${Math.round(row.pct2ResTime)}ms`).join(', ')}.`
}

function round(value: number): string {
  return value.toFixed(1)
}
