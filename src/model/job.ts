import type { RunMetrics } from '../jmeter/results'
import type { Question, TestPlanModel } from './test-plan'

export type JobSource = 'openapi' | 'har' | 'journey'

export type JobStatus =
  | 'intake'
  | 'needs_input'
  | 'planning'
  | 'validating'
  | 'running'
  | 'reviewing'
  | 'completed'
  | 'failed'

export type VerdictName = 'script_defect' | 'goal_met' | 'performance_finding'

export interface IterationRecord {
  iteration: number
  verdict: VerdictName | null
  reason: string
  patched: boolean
  metrics: RunMetrics | null
}

export interface JobArtifacts {
  plan?: string
  jmx?: string
  jtl?: string
  report?: string
}

export interface JobRecord {
  id: string
  source: JobSource
  name?: string
  status: JobStatus
  iteration: number
  questions: Question[]
  verdict: VerdictName | null
  reason: string | null
  error: string | null
  notes: string[]
  model: TestPlanModel | null
  history: IterationRecord[]
  artifacts: JobArtifacts
  createdAt: string
  updatedAt: string
}

export interface JobCreate {
  source: JobSource
  payload: unknown
  goal?: TestPlanModel['goal']
  auth?: TestPlanModel['auth']
  load?: Partial<TestPlanModel['load']>
  answers?: Record<string, string>
  name?: string
}

export function redactJob(job: JobRecord): JobRecord {
  const copy = structuredClone(job)
  if (copy.model?.auth?.token) copy.model.auth.token = '***'
  if (copy.model?.auth?.password) copy.model.auth.password = '***'
  return copy
}
