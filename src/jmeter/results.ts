import { readFileSync, existsSync } from 'node:fs'

export interface SamplerStats {
  transaction: string
  sampleCount: number
  errorCount: number
  errorPct: number
  meanResTime: number
  minResTime: number
  maxResTime: number
  pct1ResTime: number
  pct2ResTime: number
  pct3ResTime: number
  throughput: number
}

export interface RunMetrics {
  total: SamplerStats | null
  samplers: SamplerStats[]
  responseCodes: Record<string, number>
  codesByLabel: Record<string, Record<string, number>>
  assertionFailures: number
}

interface StatisticsEntry {
  transaction?: string
  sampleCount?: number
  errorCount?: number
  errorPct?: number
  meanResTime?: number
  minResTime?: number
  maxResTime?: number
  pct1ResTime?: number
  pct2ResTime?: number
  pct3ResTime?: number
  throughput?: number
}

export function emptyMetrics(): RunMetrics {
  return {
    total: null,
    samplers: [],
    responseCodes: {},
    codesByLabel: {},
    assertionFailures: 0
  }
}

export function readRunMetrics(jtlPath: string, reportDir: string | undefined, callNames: string[]): RunMetrics {
  const metrics = jtlPath && existsSync(jtlPath) ? metricsFromJtl(readFileSync(jtlPath, 'utf8'), callNames) : emptyMetrics()
  const statsPath = reportDir ? `${reportDir}/statistics.json` : ''
  if (statsPath && existsSync(statsPath)) overlayStatistics(metrics, readFileSync(statsPath, 'utf8'))
  return metrics
}

export function metricsFromJtl(csv: string, callNames: string[]): RunMetrics {
  const rows = parseCsv(csv)
  const wanted = new Set(callNames)
  const selected = wanted.size === 0 ? rows : rows.filter((row) => wanted.has(row.label ?? ''))
  const grouped = new Map<string, { elapsed: number[]; errors: number; codes: Record<string, number> }>()
  const responseCodes: Record<string, number> = {}
  let assertionFailures = 0

  for (const row of selected) {
    const label = row.label || 'sample'
    const bucket = grouped.get(label) ?? { elapsed: [], errors: 0, codes: {} }
    const elapsed = Number(row.elapsed ?? row.time ?? 0)
    if (Number.isFinite(elapsed)) bucket.elapsed.push(elapsed)
    const success = String(row.success ?? 'true').toLowerCase() !== 'false'
    if (!success) bucket.errors += 1
    const code = row.responseCode || row.response_code || ''
    if (code) {
      bucket.codes[code] = (bucket.codes[code] ?? 0) + 1
      responseCodes[code] = (responseCodes[code] ?? 0) + 1
    }
    const failure = `${row.failureMessage || ''} ${row.responseMessage || ''}`
    if (!success && /assert/i.test(failure)) assertionFailures += 1
    grouped.set(label, bucket)
  }

  const samplers = [...grouped.entries()].map(([transaction, bucket]) => toStats(transaction, bucket.elapsed, bucket.errors))
  const allElapsed = selected.map((row) => Number(row.elapsed ?? 0)).filter((value) => Number.isFinite(value))
  const errorCount = selected.filter((row) => String(row.success ?? 'true').toLowerCase() === 'false').length
  const codesByLabel: Record<string, Record<string, number>> = {}
  for (const [label, bucket] of grouped) codesByLabel[label] = bucket.codes

  return {
    total: selected.length === 0 ? null : toStats('Total', allElapsed, errorCount),
    samplers,
    responseCodes,
    codesByLabel,
    assertionFailures
  }
}

function overlayStatistics(metrics: RunMetrics, json: string): void {
  const parsed = JSON.parse(json) as Record<string, StatisticsEntry>
  for (const sampler of metrics.samplers) {
    const entry = parsed[sampler.transaction]
    if (entry) copyTiming(sampler, entry)
  }
  if (metrics.total && parsed.Total) copyTiming(metrics.total, parsed.Total)
}

function copyTiming(target: SamplerStats, entry: StatisticsEntry): void {
  if (entry.pct1ResTime != null) target.pct1ResTime = entry.pct1ResTime
  if (entry.pct2ResTime != null) target.pct2ResTime = entry.pct2ResTime
  if (entry.pct3ResTime != null) target.pct3ResTime = entry.pct3ResTime
  if (entry.meanResTime != null) target.meanResTime = entry.meanResTime
  if (entry.minResTime != null) target.minResTime = entry.minResTime
  if (entry.maxResTime != null) target.maxResTime = entry.maxResTime
  if (entry.throughput != null) target.throughput = entry.throughput
}

function toStats(transaction: string, elapsed: number[], errorCount: number): SamplerStats {
  const sampleCount = elapsed.length
  const sum = elapsed.reduce((total, value) => total + value, 0)
  return {
    transaction,
    sampleCount,
    errorCount,
    errorPct: sampleCount === 0 ? 0 : (errorCount / sampleCount) * 100,
    meanResTime: sampleCount === 0 ? 0 : sum / sampleCount,
    minResTime: sampleCount === 0 ? 0 : Math.min(...elapsed),
    maxResTime: sampleCount === 0 ? 0 : Math.max(...elapsed),
    pct1ResTime: percentile(elapsed, 90),
    pct2ResTime: percentile(elapsed, 95),
    pct3ResTime: percentile(elapsed, 99),
    throughput: 0
  }
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))
  return sorted[index]
}

export function parseCsv(csv: string): Record<string, string>[] {
  const lines = csv.split(/\r?\n/).filter((line) => line.trim() && !line.startsWith('#'))
  if (lines.length === 0) return []
  const headers = splitCsvLine(lines[0])
  const start = headers.includes('label') || headers.includes('timeStamp') ? 1 : 0
  const keys = start === 1 ? headers : ['timeStamp', 'elapsed', 'label', 'responseCode', 'responseMessage', 'threadName', 'dataType', 'success', 'failureMessage', 'bytes', 'sentBytes', 'grpThreads', 'allThreads', 'URL', 'Latency', 'IdleTime', 'Connect']
  return lines.slice(start).map((line) => {
    const columns = splitCsvLine(line)
    const row: Record<string, string> = {}
    keys.forEach((key, index) => {
      row[key] = columns[index] ?? ''
    })
    return row
  })
}

function splitCsvLine(line: string): string[] {
  const cells: string[] = []
  let current = ''
  let quoted = false
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]
    if (char === '"') {
      if (quoted && line[index + 1] === '"') {
        current += '"'
        index += 1
      } else {
        quoted = !quoted
      }
      continue
    }
    if (char === ',' && !quoted) {
      cells.push(current)
      current = ''
      continue
    }
    current += char
  }
  cells.push(current)
  return cells
}
