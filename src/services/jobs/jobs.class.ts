import { randomUUID } from 'node:crypto'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { BadRequest, Conflict, NotFound } from '@feathersjs/errors'
import { z } from 'zod'
import type { AppConfig } from '../../config'
import { runJob } from '../../agents/loop'
import { applyAnswers, applyRequestOverrides, missingQuestions } from '../../agents/questions'
import { intakeSource } from '../../intake'
import type { Engine } from '../../jmeter/engine'
import { jmeterEngine } from '../../jmeter/engine'
import { authSchema } from '../../model/test-plan'
import { redactJob, type JobCreate, type JobRecord, type JobStatus } from '../../model/job'
import { TargetNotAllowedError } from '../../security/allowlist'

const ACTIVE: JobStatus[] = ['intake', 'planning', 'validating', 'running', 'reviewing']

const createSchema = z.object({
  source: z.enum(['openapi', 'har', 'journey']),
  payload: z.unknown(),
  goal: z.object({
    p95Ms: z.number().positive().optional(),
    errorRatePct: z.number().nonnegative().optional()
  }).optional(),
  auth: authSchema.optional(),
  load: z.object({
    threads: z.number().int().positive().optional(),
    rampUpSec: z.number().int().nonnegative().optional(),
    durationSec: z.number().int().positive().optional()
  }).optional(),
  answers: z.record(z.string(), z.string()).optional(),
  name: z.string().min(1).optional()
})

const patchSchema = z.object({
  answers: z.record(z.string(), z.string()).optional()
})

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export class JobsService {
  events = ['status']
  private readonly jobs = new Map<string, JobRecord>()
  private readonly active = new Set<string>()
  private readonly engine: Engine

  constructor(private readonly config: AppConfig, engine?: Engine) {
    this.engine = engine ?? jmeterEngine(config)
    this.loadExisting()
  }

  async find(): Promise<JobRecord[]> {
    return [...this.jobs.values()]
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .map((job) => redactJob(job))
  }

  async get(id: string): Promise<JobRecord> {
    return redactJob(this.require(id))
  }

  async create(data: JobCreate): Promise<JobRecord> {
    const input = parseCreate(data)
    const id = randomUUID()
    const dir = this.directory(id)
    await mkdir(dir, { recursive: true })
    try {
      const draft = await intakeSource(input.source, input.payload, this.config, dir)
      const model = applyRequestOverrides(draft.model, input)
      const questions = missingQuestions(model)
      const now = new Date().toISOString()
      const job: JobRecord = {
        id,
        source: input.source,
        name: model.name,
        status: questions.length > 0 ? 'needs_input' : 'intake',
        iteration: 0,
        questions,
        verdict: null,
        reason: null,
        error: null,
        notes: draft.notes,
        model,
        history: [],
        artifacts: {},
        createdAt: now,
        updatedAt: now
      }
      this.jobs.set(id, job)
      await this.persist(job)
      this.notify(job)
      if (questions.length === 0) this.start(job)
      return redactJob(structuredClone(job))
    } catch (error) {
      await rm(dir, { recursive: true, force: true })
      throw asBadRequest(error)
    }
  }

  async patch(id: string, data: { answers?: Record<string, string> }): Promise<JobRecord> {
    const job = this.require(id)
    if (job.status !== 'needs_input' || !job.model) {
      throw new Conflict('Job is not waiting for answers')
    }
    const input = patchSchema.parse(data)
    try {
      job.model = applyAnswers(job.model, input.answers)
    } catch (error) {
      throw asBadRequest(error)
    }
    job.questions = missingQuestions(job.model)
    job.updatedAt = new Date().toISOString()
    await this.persist(job)
    this.notify(job)
    if (job.questions.length === 0) this.start(job)
    return redactJob(structuredClone(job))
  }

  private start(job: JobRecord): void {
    if (this.active.has(job.id)) return
    this.active.add(job.id)
    setImmediate(() => {
      void runJob(job, this.config, this.engine, {
        onUpdate: (current) => {
          this.notify(current)
          void this.persist(current)
        }
      }).finally(() => {
        this.active.delete(job.id)
      })
    })
  }

  private require(id: string): JobRecord {
    if (!UUID.test(id)) throw new NotFound(`Job ${id} not found`)
    const job = this.jobs.get(id)
    if (!job) throw new NotFound(`Job ${id} not found`)
    return job
  }

  private directory(id: string): string {
    return join(resolve(this.config.dataDir), id)
  }

  private async persist(job: JobRecord): Promise<void> {
    const dir = this.directory(job.id)
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'job.json'), JSON.stringify(job, null, 2), 'utf8')
  }

  private notify(job: JobRecord): void {
    const service = this as JobsService & {
      emit?: (event: string, payload: unknown) => boolean
    }
    if (typeof service.emit !== 'function') return
    service.emit('status', {
      id: job.id,
      status: job.status,
      iteration: job.iteration,
      verdict: job.verdict
    })
    service.emit('patched', redactJob(job))
  }

  private loadExisting(): void {
    const root = resolve(this.config.dataDir)
    if (!existsSync(root)) return
    for (const entry of readdirSync(root)) {
      const file = join(root, entry, 'job.json')
      if (!existsSync(file)) continue
      try {
        const job = JSON.parse(readFileSync(file, 'utf8')) as JobRecord
        if (!job?.id || !UUID.test(job.id)) continue
        if (ACTIVE.includes(job.status)) {
          job.status = 'failed'
          job.error = 'Server restarted before the job finished'
        }
        this.jobs.set(job.id, job)
      } catch {
        // Ignore unreadable job files.
      }
    }
  }
}

function parseCreate(data: JobCreate): JobCreate {
  try {
    return createSchema.parse(data) as JobCreate
  } catch (error) {
    throw asBadRequest(error)
  }
}

function asBadRequest(error: unknown): BadRequest {
  if (error instanceof BadRequest) return error
  if (error instanceof TargetNotAllowedError) return new BadRequest(error.message)
  if (error instanceof z.ZodError) return new BadRequest(error.issues.map((issue) => issue.message).join('; '))
  if (error instanceof Error) return new BadRequest(error.message)
  return new BadRequest(String(error))
}
