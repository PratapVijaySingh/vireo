import { mkdir, writeFile } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import type { AppConfig } from '../config'
import type { Engine } from '../jmeter/engine'
import { buildJmx } from '../jmeter/jmx-builder'
import { callNames } from '../model/test-plan'
import type { JobRecord } from '../model/job'
import { planModel } from './planner'
import { refineScriptDefect, reviewRun } from './reviewer'
import { acceptReviewerPatch } from './safety'

export interface LoopHooks {
  onUpdate: (job: JobRecord) => void
}

export async function runJob(job: JobRecord, config: AppConfig, engine: Engine, hooks: LoopHooks): Promise<void> {
  const dir = resolve(config.dataDir, job.id)
  try {
    if (!job.model) throw new Error('Job has no test plan')
    await mkdir(dir, { recursive: true })
    let model = job.model

    for (let iteration = 1; iteration <= config.maxIterations; iteration += 1) {
      job.iteration = iteration
      if (iteration === 1) {
        setStatus(job, 'planning', hooks)
        const planned = await planModel(model, config)
        job.notes.push(...planned.notes)
        model = planned.model
        job.model = model
        if (planned.questions.length > 0) {
          job.questions = planned.questions
          setStatus(job, 'needs_input', hooks)
          return
        }
      }

      const planPath = join(dir, 'plan.json')
      const jmxPath = join(dir, 'plan.jmx')
      await writeFile(planPath, JSON.stringify(model, null, 2), 'utf8')
      await writeFile(jmxPath, buildJmx(model), 'utf8')
      job.artifacts.plan = toRelative(planPath)
      job.artifacts.jmx = toRelative(jmxPath)
      hooks.onUpdate(job)

      setStatus(job, 'validating', hooks)
      await engine.validate(model, dir)

      setStatus(job, 'running', hooks)
      const result = await engine.run(jmxPath, dir, iteration, callNames(model))
      if (result.jtlPath) job.artifacts.jtl = toRelative(result.jtlPath)
      if (result.reportPath) job.artifacts.report = toRelative(result.reportPath)
      if (result.warning) job.notes.push(result.warning)

      setStatus(job, 'reviewing', hooks)
      let decision = reviewRun(model, result.metrics)
      decision = await refineScriptDefect(model, result.metrics, decision, config)
      const canRevise = decision.verdict === 'script_defect' && decision.patch && iteration < config.maxIterations
      job.history.push({
        iteration,
        verdict: decision.verdict,
        reason: decision.reason,
        patched: Boolean(canRevise),
        metrics: result.metrics
      })

      if (decision.questions.length > 0) {
        job.questions = decision.questions
        job.verdict = decision.verdict
        job.reason = decision.reason
        setStatus(job, 'needs_input', hooks)
        return
      }

      if (canRevise && decision.patch) {
        const accepted = acceptReviewerPatch(model, decision.patch, config)
        if (accepted.ok) {
          model = accepted.model
          job.model = model
          job.notes.push(...accepted.notes)
          continue
        }
        decision = { ...decision, reason: `${decision.reason} ${accepted.rejected.join(' ')}`.trim(), patch: null }
      }

      job.verdict = decision.verdict
      job.reason = iteration === config.maxIterations && decision.verdict === 'script_defect'
        ? `${decision.reason} Stopped after ${config.maxIterations} iterations.`
        : decision.reason
      job.questions = []
      setStatus(job, 'completed', hooks)
      return
    }
  } catch (error) {
    job.status = 'failed'
    job.error = error instanceof Error ? error.message : String(error)
    job.updatedAt = new Date().toISOString()
    hooks.onUpdate(job)
  }
}

function setStatus(job: JobRecord, status: JobRecord['status'], hooks: LoopHooks): void {
  job.status = status
  job.updatedAt = new Date().toISOString()
  hooks.onUpdate(job)
}

function toRelative(file: string): string {
  return relative(process.cwd(), file).split('\\').join('/')
}
