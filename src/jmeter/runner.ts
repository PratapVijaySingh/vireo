import { spawn } from 'node:child_process'
import { rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'

export interface JMeterRunRequest {
  jmeterBin: string
  jmxPath: string
  jtlPath: string
  logPath: string
  reportDir?: string
}

export interface JMeterRunOutput {
  code: number
  stdout: string
  stderr: string
}

export class JMeterBinaryMissingError extends Error {
  constructor() {
    super('JMETER_BIN is not set. The .jmx was written, but JMeter was not started.')
    this.name = 'JMeterBinaryMissingError'
  }
}

export function quoteCmd(value: string): string {
  if (value.length === 0) return '""'
  if (!/[\s"&|<>^]/.test(value)) return value
  return `"${value.replace(/"/g, '""')}"`
}

export function resolveJmeterCommand(jmeterBin: string): string {
  if (/\.(bat|cmd|sh|exe)$/i.test(jmeterBin)) return jmeterBin
  const name = process.platform === 'win32' ? 'jmeter.bat' : 'jmeter'
  return join(jmeterBin, name)
}

function jmeterEnvironment(jmeterBin: string): NodeJS.ProcessEnv {
  const command = resolveJmeterCommand(jmeterBin)
  const directory = dirname(command)
  const separator = directory.endsWith('\\') || directory.endsWith('/') ? '' : (process.platform === 'win32' ? '\\' : '/')
  return {
    ...process.env,
    JMETER_BIN: `${directory}${separator}`
  }
}

export function runJmeter(request: JMeterRunRequest): Promise<JMeterRunOutput> {
  if (!request.jmeterBin) return Promise.reject(new JMeterBinaryMissingError())
  const commandPath = resolveJmeterCommand(request.jmeterBin)

  const args = [
    '-n',
    '-t', request.jmxPath,
    '-l', request.jtlPath,
    '-j', request.logPath,
    '-Jjmeter.save.saveservice.output_format=csv',
    '-Jjmeter.save.saveservice.print_field_names=true',
    '-Jjmeter.save.saveservice.response_code=true',
    '-Jjmeter.save.saveservice.successful=true',
    '-Jjmeter.save.saveservice.label=true',
    '-Jjmeter.save.saveservice.assertion_results_failure_message=true',
    '-Jjmeter.save.saveservice.time=true'
  ]
  if (request.reportDir) args.push('-e', '-o', request.reportDir)

  const command = [quoteCmd(commandPath), ...args.map(quoteCmd)].join(' ')

  return new Promise((resolve, reject) => {
    const child = spawn(command, {
      shell: true,
      windowsHide: true,
      env: jmeterEnvironment(request.jmeterBin),
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let stdout = ''
    let stderr = ''
    const capture = (chunk: Buffer, target: 'stdout' | 'stderr') => {
      const text = chunk.toString('utf8')
      if (target === 'stdout') stdout = (stdout + text).slice(-12000)
      else stderr = (stderr + text).slice(-12000)
    }
    child.stdout?.on('data', (chunk: Buffer) => capture(chunk, 'stdout'))
    child.stderr?.on('data', (chunk: Buffer) => capture(chunk, 'stderr'))
    child.on('error', reject)
    child.on('close', (code) => {
      resolve({ code: code ?? 1, stdout, stderr })
    })
  })
}

export async function prepareReportDir(reportDir: string | undefined): Promise<void> {
  if (!reportDir) return
  await rm(reportDir, { recursive: true, force: true })
}
