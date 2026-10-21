import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { metricsFromJtl, readRunMetrics } from '../src/jmeter/results'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const csv = [
  'timeStamp,elapsed,label,responseCode,responseMessage,threadName,dataType,success,failureMessage,bytes,sentBytes,grpThreads,allThreads,URL,Latency,IdleTime,Connect',
  '1,20,GET /health,201,Created,Users 1-1,text,false,Test failed: assertion,10,10,1,1,http://127.0.0.1/health,18,0,2',
  '2,40,GET /health,201,Created,Users 1-1,text,false,Test failed: assertion,10,10,1,1,http://127.0.0.1/health,30,0,2',
  '3,15,Health scenario,201,,Users 1-1,text,false,,10,10,1,1,http://127.0.0.1/health,10,0,2'
].join('\n')

describe('results parser', () => {
  it('summarizes sampler rows and ignores the transaction parent when call names are known', () => {
    const metrics = metricsFromJtl(csv, ['GET /health'])
    assert.equal(metrics.total?.sampleCount, 2)
    assert.equal(metrics.total?.errorCount, 2)
    assert.equal(metrics.responseCodes['201'], 2)
    assert.equal(metrics.codesByLabel['GET /health']['201'], 2)
    assert.equal(metrics.samplers[0].pct2ResTime, 40)
    assert.ok(metrics.assertionFailures >= 1)
  })

  it('overlays p95 from statistics.json', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'jmeter-report-'))
    const jtl = join(dir, 'results.jtl')
    const report = join(dir, 'report')
    await writeFile(jtl, csv, 'utf8')
    const { mkdir } = await import('node:fs/promises')
    await mkdir(report)
    await writeFile(join(report, 'statistics.json'), JSON.stringify({
      'GET /health': { transaction: 'GET /health', pct2ResTime: 95, meanResTime: 30 },
      Total: { transaction: 'Total', pct2ResTime: 96 }
    }), 'utf8')
    const metrics = readRunMetrics(jtl, report, ['GET /health'])
    assert.equal(metrics.samplers[0].pct2ResTime, 95)
    assert.equal(metrics.total?.pct2ResTime, 96)
    await rm(dir, { recursive: true, force: true })
  })
})
