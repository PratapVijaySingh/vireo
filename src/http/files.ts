import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs'
import { extname, resolve, sep } from 'node:path'
import type { Context, Next } from 'koa'
import type { AppConfig } from '../config'
import type { JobRecord } from '../model/job'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export function publicWorkbench(config: AppConfig) {
  return {
    allowedHosts: config.allowedHosts,
    maxThreads: config.maxThreads,
    maxDurationSec: config.maxDurationSec,
    defaultThreads: config.defaultThreads,
    defaultDurationSec: config.defaultDurationSec,
    defaultRampUpSec: config.defaultRampUpSec,
    maxIterations: config.maxIterations,
    jmeterConfigured: Boolean(config.jmeterBin),
    llmConfigured: Boolean(config.llmApiKey)
  }
}

export function filesMiddleware(config: AppConfig) {
  const dataRoot = resolve(config.dataDir)

  return async (ctx: Context, next: Next) => {
    if (ctx.method === 'GET' && ctx.path === '/workbench') {
      ctx.body = publicWorkbench(config)
      return
    }

    const plan = /^\/files\/([^/]+)\/plan\.jmx$/i.exec(ctx.path)
    if (ctx.method === 'GET' && plan) {
      if (!UUID.test(plan[1])) {
        ctx.status = 404
        return
      }
      const file = resolve(dataRoot, plan[1], 'plan.jmx')
      if (!isInside(dataRoot, file) || !existsSync(file)) {
        ctx.status = 404
        ctx.body = { message: 'Script has not been written yet' }
        return
      }
      ctx.set('Cache-Control', 'no-store')
      ctx.attachment('plan.jmx')
      ctx.type = 'application/xml'
      ctx.body = createReadStream(file)
      return
    }

    const report = /^\/files\/([^/]+)\/report(?:\/(.*))?$/i.exec(ctx.path)
    if (ctx.method === 'GET' && report) {
      if (!UUID.test(report[1])) {
        ctx.status = 404
        return
      }
      const reportRoot = reportDirectory(dataRoot, report[1])
      if (!reportRoot) {
        ctx.status = 404
        ctx.body = { message: 'Report is not ready' }
        return
      }
      const relative = report[2] && report[2].length > 0 ? report[2] : 'index.html'
      const target = resolve(reportRoot, relative)
      if (!isInside(reportRoot, target) || !existsSync(target) || !statSync(target).isFile()) {
        ctx.status = 404
        return
      }
      ctx.set('Cache-Control', 'no-store')
      ctx.type = extname(target) || 'application/octet-stream'
      ctx.body = createReadStream(target)
      return
    }

    await next()
  }
}

function reportDirectory(dataRoot: string, id: string): string | null {
  const jobFile = resolve(dataRoot, id, 'job.json')
  if (!isInside(dataRoot, jobFile) || !existsSync(jobFile)) return null
  const job = JSON.parse(readFileSync(jobFile, 'utf8')) as JobRecord
  if (!job.artifacts?.report) return null
  const reportRoot = resolve(process.cwd(), job.artifacts.report)
  if (!isInside(dataRoot, reportRoot)) return null
  return reportRoot
}

function isInside(parent: string, child: string): boolean {
  const base = resolve(parent).toLowerCase()
  const target = resolve(child).toLowerCase()
  return target === base || target.startsWith(base + sep)
}
