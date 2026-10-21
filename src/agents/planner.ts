import type { AppConfig } from '../config'
import { clampLoad, redactModel, type Question, type TestPlanModel } from '../model/test-plan'
import { missingQuestions } from './questions'
import { completeWithTools } from './llm'
import { acceptPlannerModel } from './safety'

export interface PlanResult {
  model: TestPlanModel
  questions: Question[]
  notes: string[]
}

export async function planModel(model: TestPlanModel, config: AppConfig): Promise<PlanResult> {
  const questions = missingQuestions(model)
  if (questions.length > 0) return { model, questions, notes: [] }

  const deterministic = deterministicPlan(model, config)
  if (!config.llmApiKey) {
    return {
      model: deterministic,
      questions: [],
      notes: ['Planner used deterministic defaults because LLM_API_KEY is not set']
    }
  }

  const turn = await completeWithTools(config, [
    {
      role: 'system',
      content: [
        'You write performance-test plans for JMeter.',
        'Call update_test_plan with the complete model, or ask_user when a credential, body, or goal is missing.',
        'Do not invent tokens or passwords. Do not change baseUrl.',
        `Keep threads <= ${config.maxThreads} and durationSec <= ${config.maxDurationSec}.`,
        'Add status assertions, think time, and JSON or regex extractors when a later call needs a value from an earlier response.',
        'Leave a slow application alone. Do not delete calls to make the goal easier.'
      ].join(' ')
    },
    {
      role: 'user',
      content: JSON.stringify(redactModel(deterministic))
    }
  ])

  if (turn.error) {
    return { model: deterministic, questions: [], notes: [`Planner used deterministic defaults (${turn.error})`] }
  }

  const ask = turn.toolCalls.find((call) => call.name === 'ask_user')
  const asked = questionsFromTool(ask?.arguments)
  if (asked.length > 0) return { model: deterministic, questions: asked, notes: [] }

  const update = turn.toolCalls.find((call) => call.name === 'update_test_plan')
  const proposed = (update?.arguments as { plan?: unknown } | undefined)?.plan
  if (!proposed) {
    return { model: deterministic, questions: [], notes: ['Planner used deterministic defaults (no update_test_plan call)'] }
  }

  const accepted = acceptPlannerModel(model, proposed, config)
  if (!accepted.ok) {
    return { model: deterministic, questions: [], notes: ['Planner kept the deterministic plan', ...accepted.rejected] }
  }
  const remaining = missingQuestions(accepted.model)
  if (remaining.length > 0) return { model: accepted.model, questions: remaining, notes: accepted.notes }
  return { model: accepted.model, questions: [], notes: accepted.notes }
}

function questionsFromTool(args: unknown): Question[] {
  if (!args || typeof args !== 'object' || !('questions' in args)) return []
  const questions = (args as { questions?: unknown }).questions
  if (!Array.isArray(questions)) return []
  return questions.flatMap((item) => {
    if (!item || typeof item !== 'object') return []
    const id = 'id' in item ? String(item.id) : ''
    const prompt = 'prompt' in item ? String(item.prompt) : ''
    if (!id || !prompt) return []
    return [{ id, prompt }]
  })
}

function deterministicPlan(model: TestPlanModel, config: AppConfig): TestPlanModel {
  const next = structuredClone(model)
  clampLoad(next, config)
  for (const scenario of next.scenarios) {
    for (const call of scenario.calls) {
      if (call.thinkTimeMs == null) call.thinkTimeMs = 200
      if (!call.assertions || call.assertions.length === 0) {
        call.assertions = [{ type: 'status', expected: '200' }]
      }
    }
  }
  return next
}
