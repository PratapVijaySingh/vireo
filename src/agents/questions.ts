import type { Question, TestPlanModel } from '../model/test-plan'
import { hasGoal } from '../model/test-plan'

export function missingQuestions(model: TestPlanModel): Question[] {
  const questions: Question[] = []
  if (model.auth?.type === 'bearer' && !model.auth.token) {
    questions.push({ id: 'token', prompt: 'Bearer token for the system under test' })
  }
  if (model.auth?.type === 'basic' && !model.auth.username) {
    questions.push({ id: 'username', prompt: 'Basic auth username' })
  }
  if (model.auth?.type === 'basic' && !model.auth.password) {
    questions.push({ id: 'password', prompt: 'Basic auth password' })
  }

  model.scenarios.forEach((scenario, scenarioIndex) => {
    scenario.calls.forEach((call, callIndex) => {
      if (call.requiresBody && (call.body == null || call.body.trim() === '')) {
        questions.push({
          id: `body:${scenarioIndex}:${callIndex}`,
          prompt: `JSON body for ${call.method.toUpperCase()} ${call.path}`
        })
      }
    })
  })

  if (!hasGoal(model)) {
    questions.push({
      id: 'goal',
      prompt: 'Performance goal as JSON, for example {"p95Ms":500,"errorRatePct":1}'
    })
  }
  return questions
}

export function applyAnswers(model: TestPlanModel, answers: Record<string, string> | undefined): TestPlanModel {
  if (!answers || Object.keys(answers).length === 0) return model
  const next = structuredClone(model)

  if (answers.token) {
    next.auth = {
      ...(next.auth ?? { type: 'bearer' }),
      type: next.auth?.type === 'basic' ? 'basic' : 'bearer',
      token: answers.token,
      tokenVar: next.auth?.tokenVar || 'token'
    }
  }
  if (answers.username || answers.password) {
    next.auth = {
      ...(next.auth ?? { type: 'basic' }),
      type: 'basic',
      username: answers.username ?? next.auth?.username,
      password: answers.password ?? next.auth?.password
    }
  }
  if (answers.p95Ms) next.goal = { ...next.goal, p95Ms: Number(answers.p95Ms) }
  if (answers.errorRatePct) next.goal = { ...next.goal, errorRatePct: Number(answers.errorRatePct) }
  if (answers.goal) {
    let parsed: { p95Ms?: number; errorRatePct?: number }
    try {
      parsed = JSON.parse(answers.goal) as { p95Ms?: number; errorRatePct?: number }
    } catch {
      throw new Error('goal answer must be JSON with p95Ms and/or errorRatePct')
    }
    next.goal = { ...next.goal, ...parsed }
  }

  for (const [key, value] of Object.entries(answers)) {
    const match = /^body:(\d+):(\d+)$/.exec(key)
    if (!match) continue
    const call = next.scenarios[Number(match[1])]?.calls[Number(match[2])]
    if (!call) continue
    call.body = value
    call.requiresBody = false
    call.contentType = call.contentType || 'application/json'
  }

  return next
}

export function applyRequestOverrides(
  model: TestPlanModel,
  input: {
    goal?: TestPlanModel['goal']
    auth?: TestPlanModel['auth']
    load?: Partial<TestPlanModel['load']>
    name?: string
    answers?: Record<string, string>
  }
): TestPlanModel {
  const next = structuredClone(model)
  if (input.name) next.name = input.name
  if (input.goal) next.goal = { ...next.goal, ...input.goal }
  if (input.load) next.load = { ...next.load, ...input.load }
  if (input.auth) next.auth = { ...(next.auth ?? { type: 'none' }), ...input.auth }
  return applyAnswers(next, input.answers)
}
