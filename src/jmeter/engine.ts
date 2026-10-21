import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { AppConfig } from '../config'
import type { TestPlanModel } from '../model/test-plan'
import { buildJmx } from './jmx-builder'
import { readRunMetrics, type RunMetrics } from './results'
import { JMeterBinaryMissingError, prepareReportDir, runJmeter } from './runner'

export interface EngineRunResult {
  metrics: RunMetrics
  jtlPath: string
  reportPath?: string
  warning?: string
}

export interface Engine {
  validate(model: TestPlanModel, dir: string): Promise<{ mode: 'engine' | 'xml-only' }>
  run(jmxPath: string, dir: string, iteration: number, callNames: string[]): Promise<EngineRunResult>
}

export function jmeterEngine(config: AppConfig): Engine {
  return {
    async validate(model, dir) {
      const xml = buildJmx(model, { mode: 'validate' })
      const jmxPath = join(dir, 'validate.jmx')
      await writeFile(jmxPath, xml, 'utf8')
      if (!config.jmeterBin) return { mode: 'xml-only' }
      const output = await runJmeter({
        jmeterBin: config.jmeterBin,
        jmxPath,
        jtlPath: join(dir, 'validate.jtl'),
        logPath: join(dir, 'validate.log')
      })
      if (output.code !== 0) {
        throw new Error(`JMeter rejected the test plan (${output.code}): ${(output.stderr || output.stdout).slice(-2000)}`)
      }
      return { mode: 'engine' }
    },

    async run(jmxPath, dir, iteration, names) {
      if (!config.jmeterBin) throw new JMeterBinaryMissingError()
      const iterationDir = join(dir, `iteration-${iteration}`)
      await mkdir(iterationDir, { recursive: true })
      const jtlPath = join(iterationDir, 'results.jtl')
      const reportDir = join(iterationDir, 'report')
      await prepareReportDir(reportDir)
      const output = await runJmeter({
        jmeterBin: config.jmeterBin,
        jmxPath,
        jtlPath,
        logPath: join(iterationDir, 'jmeter.log'),
        reportDir
      })
      if (output.code !== 0 && !existsSync(jtlPath)) {
        throw new Error(`JMeter exited ${output.code}: ${(output.stderr || output.stdout).slice(-2000)}`)
      }
      const reportReady = existsSync(join(reportDir, 'index.html'))
      return {
        metrics: readRunMetrics(jtlPath, reportReady ? reportDir : undefined, names),
        jtlPath,
        reportPath: reportReady ? reportDir : undefined,
        warning: output.code !== 0 ? `JMeter exited ${output.code}` : undefined
      }
    }
  }
}

export { JMeterBinaryMissingError }
