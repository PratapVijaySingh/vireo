import type { AppConfig } from '../config'
import { defaultLoad, uniqueName, type HttpCall, type Scenario, type TestPlanModel } from '../model/test-plan'
import { assertAllowedUrl } from '../security/allowlist'

const SKIP_EXTENSION = /\.(png|jpe?g|gif|webp|svg|css|js|mjs|map|woff2?|ttf|ico|mp4|webm)(\?|$)/i
const ANALYTICS = /(google-analytics|googletagmanager|doubleclick\.net|facebook\.net|hotjar|segment\.io|sentry\.io)/i
const STATIC_TYPES = new Set(['image', 'stylesheet', 'font', 'script', 'media'])
const INTERESTING_KEYS = /^(id|.*Id|token|access_token|refresh_token|jwt|session|sessionId)$/i

interface HarHeader {
  name: string
  value: string
}

interface HarEntry {
  pageref?: string
  _resourceType?: string
  request: {
    method: string
    url: string
    headers?: HarHeader[]
    postData?: { text?: string; mimeType?: string }
  }
  response?: {
    status?: number
    content?: { mimeType?: string; text?: string }
  }
}

interface HarDocument {
  log?: { entries?: HarEntry[] }
  entries?: HarEntry[]
}

export interface IntakeDraft {
  model: TestPlanModel
  notes: string[]
}

interface KeptCall {
  group: string
  call: HttpCall
  responseText?: string
}

export function intakeHar(payload: unknown, config: AppConfig): IntakeDraft {
  const document = payload as HarDocument
  const entries = document.log?.entries ?? document.entries
  if (!Array.isArray(entries)) throw new Error('HAR payload is missing log.entries')

  const keptUrls: { entry: HarEntry; url: URL }[] = []
  for (const entry of entries) {
    if (!entry?.request?.url || !entry.request.method) continue
    let url: URL
    try {
      url = new URL(entry.request.url)
    } catch {
      continue
    }
    if (!keepEntry(entry, url)) continue
    keptUrls.push({ entry, url })
  }
  if (keptUrls.length === 0) throw new Error('No HTTP calls left after filtering static assets')

  const counts = new Map<string, number>()
  for (const item of keptUrls) counts.set(item.url.origin, (counts.get(item.url.origin) ?? 0) + 1)
  const primary = [...counts.entries()].sort((left, right) => right[1] - left[1])[0][0]
  assertAllowedUrl(primary, config.allowedHosts)

  const notes: string[] = []
  const dropped = keptUrls.filter((item) => item.url.origin !== primary).length
  if (dropped > 0) notes.push(`Dropped ${dropped} requests on other hosts`)

  const names = new Set<string>()
  const kept: KeptCall[] = []
  for (const item of keptUrls) {
    if (item.url.origin !== primary) continue
    kept.push({
      group: item.entry.pageref || 'Recorded journey',
      call: callFromEntry(item.entry, item.url, names),
      responseText: item.entry.response?.content?.text
    })
  }

  const calls = kept.map((item) => item.call)
  correlateCalls(calls, kept.map((item) => item.responseText))
  const auth = authFromCalls(calls)

  const groups = new Map<string, HttpCall[]>()
  for (const item of kept) {
    const list = groups.get(item.group) ?? []
    list.push(item.call)
    groups.set(item.group, list)
  }
  const scenarios: Scenario[] = [...groups.entries()].map(([name, groupCalls]) => ({ name, calls: groupCalls }))

  return {
    notes,
    model: {
      name: 'Recorded performance test',
      baseUrl: primary,
      auth,
      scenarios,
      load: defaultLoad(config)
    }
  }
}

function keepEntry(entry: HarEntry, url: URL): boolean {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
  if (ANALYTICS.test(url.hostname) || ANALYTICS.test(url.href)) return false
  if (SKIP_EXTENSION.test(url.pathname)) return false
  if (entry._resourceType && STATIC_TYPES.has(entry._resourceType)) return false
  const mime = entry.response?.content?.mimeType ?? ''
  if (mime.startsWith('image/') || mime.includes('javascript') || mime.includes('css') || mime.startsWith('font/')) return false
  return true
}

function callFromEntry(entry: HarEntry, url: URL, names: Set<string>): HttpCall {
  const headers: Record<string, string> = {}
  for (const header of entry.request.headers ?? []) {
    const name = header.name.toLowerCase()
    if (name.startsWith(':')) continue
    if (['host', 'content-length', 'connection', 'accept-encoding', 'cookie'].includes(name)) continue
    headers[header.name] = header.value
  }
  const status = entry.response?.status ?? 200
  const assertionStatus = status >= 200 && status < 400 ? String(status) : '200'
  return {
    name: uniqueName(names, `${entry.request.method.toUpperCase()} ${url.pathname}`),
    method: entry.request.method.toUpperCase(),
    path: `${url.pathname}${url.search}`,
    headers,
    body: entry.request.postData?.text,
    contentType: entry.request.postData?.mimeType,
    assertions: [{ type: 'status', expected: assertionStatus }]
  }
}

interface Candidate {
  callIndex: number
  name: string
  jsonPath: string
  value: string
}

export function correlateCalls(calls: HttpCall[], bodies: (string | undefined)[]): void {
  const candidates: Candidate[] = []
  const usedNames = new Set<string>()
  bodies.forEach((body, callIndex) => {
    if (!body) return
    let parsed: unknown
    try {
      parsed = JSON.parse(body)
    } catch {
      return
    }
    walkJson(parsed, '$', (jsonPath, key, value) => {
      if (!INTERESTING_KEYS.test(key)) return
      const text = String(value)
      if (typeof value === 'string' && text.length < 8) return
      if (typeof value === 'number' && !/^id$/i.test(key)) return
      if (text.length < 1 || text.length > 200) return
      let name = key.replace(/[^A-Za-z0-9_]/g, '_')
      if (/^[0-9]/.test(name)) name = `v_${name}`
      const base = name
      let suffix = 2
      while (usedNames.has(name)) {
        name = `${base}_${suffix}`
        suffix += 1
      }
      usedNames.add(name)
      candidates.push({ callIndex, name, jsonPath, value: text })
    })
  })

  candidates.sort((left, right) => right.value.length - left.value.length)
  for (const candidate of candidates) {
    let used = false
    for (let index = candidate.callIndex + 1; index < calls.length; index += 1) {
      if (replaceValue(calls[index], candidate.value, `\${${candidate.name}}`)) used = true
    }
    if (!used) continue
    const source = calls[candidate.callIndex]
    source.extractors = source.extractors ?? []
    if (!source.extractors.some((item) => item.name === candidate.name)) {
      source.extractors.push({
        name: candidate.name,
        source: 'json',
        expression: candidate.jsonPath,
        matchNumber: 1,
        defaultValue: 'NOT_FOUND'
      })
    }
  }
}

function replaceValue(call: HttpCall, value: string, variable: string): boolean {
  let changed = false
  if (call.path.includes(value)) {
    call.path = call.path.split(value).join(variable)
    changed = true
  }
  if (call.body?.includes(value)) {
    call.body = call.body.split(value).join(variable)
    changed = true
  }
  for (const [name, header] of Object.entries(call.headers ?? {})) {
    if (!header.includes(value)) continue
    call.headers![name] = header.split(value).join(variable)
    changed = true
  }
  return changed
}

function walkJson(node: unknown, path: string, visit: (path: string, key: string, value: string | number) => void, key = ''): void {
  if (typeof node === 'string' || typeof node === 'number') {
    if (key) visit(path, key, node)
    return
  }
  if (Array.isArray(node)) {
    node.forEach((item, index) => walkJson(item, `${path}[${index}]`, visit, key))
    return
  }
  if (node && typeof node === 'object') {
    for (const [childKey, value] of Object.entries(node)) {
      const next = path === '$' ? `$.${childKey}` : `${path}.${childKey}`
      walkJson(value, next, visit, childKey)
    }
  }
}

function authFromCalls(calls: HttpCall[]): TestPlanModel['auth'] {
  for (const call of calls) {
    const header = Object.entries(call.headers ?? {}).find(([name]) => name.toLowerCase() === 'authorization')
    if (!header) continue
    if (/^bearer\s+\$\{.+\}$/i.test(header[1])) {
      const variable = /\$\{(.+)\}/.exec(header[1])?.[1] ?? 'token'
      delete call.headers?.[header[0]]
      return { type: 'bearer', tokenVar: variable, headerName: 'Authorization', headerPrefix: 'Bearer ' }
    }
  }
  return { type: 'none' }
}
