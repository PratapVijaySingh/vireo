import SwaggerParser from '@apidevtools/swagger-parser'
import type { AppConfig } from '../config'
import { defaultLoad, uniqueName, type Auth, type HttpCall, type TestPlanModel } from '../model/test-plan'
import { assertAllowedUrl, originOf, stripUserInfo } from '../security/allowlist'

const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const
const MAX_OPERATIONS = 25

interface JsonSchema {
  type?: string
  format?: string
  example?: unknown
  default?: unknown
  enum?: unknown[]
  properties?: Record<string, JsonSchema>
  required?: string[]
  items?: JsonSchema
  allOf?: JsonSchema[]
  oneOf?: JsonSchema[]
  anyOf?: JsonSchema[]
}

interface Parameter {
  name?: string
  in?: string
  required?: boolean
  example?: unknown
  schema?: JsonSchema
}

interface Operation {
  operationId?: string
  summary?: string
  deprecated?: boolean
  parameters?: Parameter[]
  requestBody?: {
    required?: boolean
    content?: Record<string, { example?: unknown; schema?: JsonSchema; examples?: Record<string, { value?: unknown }> }>
  }
  responses?: Record<string, { content?: Record<string, { example?: unknown; schema?: JsonSchema }> }>
  security?: Record<string, string[]>[]
}

interface SecurityScheme {
  type?: string
  scheme?: string
  name?: string
  in?: string
}

interface OpenApiDocument {
  info?: { title?: string }
  servers?: { url?: string }[]
  host?: string
  basePath?: string
  schemes?: string[]
  paths?: Record<string, Partial<Record<(typeof HTTP_METHODS)[number], Operation>>>
  components?: { securitySchemes?: Record<string, SecurityScheme> }
  securityDefinitions?: Record<string, SecurityScheme>
  security?: Record<string, string[]>[]
}

interface PostmanUrl {
  raw?: string
}

interface PostmanRequest {
  method?: string
  url?: string | PostmanUrl
  header?: { key?: string; value?: string; disabled?: boolean }[]
  body?: { mode?: string; raw?: string }
}

interface PostmanItem {
  name?: string
  item?: PostmanItem[]
  request?: PostmanRequest
}

interface PostmanCollection {
  info?: { name?: string; schema?: string }
  item?: PostmanItem[]
}

export interface IntakeDraft {
  model: TestPlanModel
  notes: string[]
}

export function isPostmanCollection(payload: unknown): payload is PostmanCollection {
  if (!payload || typeof payload !== 'object') return false
  const doc = payload as PostmanCollection
  return Array.isArray(doc.item) && typeof doc.info?.schema === 'string' && doc.info.schema.toLowerCase().includes('postman')
}

export async function intakeOpenApi(payload: unknown, config: AppConfig): Promise<IntakeDraft> {
  if (isPostmanCollection(payload)) return intakePostman(payload, config)
  const document = await SwaggerParser.dereference(structuredClone(payload) as never) as OpenApiDocument
  return openApiToModel(document, config)
}

export function openApiToModel(document: OpenApiDocument, config: AppConfig): IntakeDraft {
  const notes: string[] = []
  const server = resolveServer(document)
  const cleaned = stripUserInfo(server)
  assertAllowedUrl(cleaned.url, config.allowedHosts)
  const serverUrl = new URL(cleaned.url)
  const basePath = serverUrl.pathname.replace(/\/$/, '')
  const names = new Set<string>()
  const calls: HttpCall[] = []
  const schemes = document.components?.securitySchemes ?? document.securityDefinitions ?? {}
  let auth: Auth = { type: 'none' }
  if (cleaned.username || cleaned.password) {
    auth = { type: 'basic', username: cleaned.username, password: cleaned.password }
  }

  const extracted = new Set<string>()
  for (const [path, methods] of Object.entries(document.paths ?? {})) {
    for (const method of HTTP_METHODS) {
      const operation = methods?.[method]
      if (!operation || operation.deprecated) continue
      if (calls.length >= MAX_OPERATIONS) {
        notes.push(`Stopped after ${MAX_OPERATIONS} operations`)
        break
      }
      const operationAuth = authFromSecurity(operation.security ?? document.security, schemes)
      if (auth.type === 'none' && operationAuth.type !== 'none') auth = operationAuth
      const built = buildCall(method, path, basePath, operation, names, extracted)
      calls.push(built.call)
      for (const name of built.produced) extracted.add(name)
    }
  }

  if (calls.length === 0) throw new Error('OpenAPI document has no operations to test')
  if (auth.type === 'none') {
    const fallback = authFromSecurity(document.security, schemes)
    if (fallback.type !== 'none') auth = fallback
  }

  return {
    notes,
    model: {
      name: document.info?.title || 'OpenAPI performance test',
      baseUrl: originOf(cleaned.url),
      auth,
      scenarios: [{ name: 'API scenario', calls }],
      load: defaultLoad(config)
    }
  }
}

function resolveServer(document: OpenApiDocument): string {
  const server = document.servers?.find((item) => item.url && /^https?:\/\//i.test(item.url))?.url
  if (server) return server
  if (document.host) {
    const scheme = document.schemes?.includes('https') ? 'https' : 'http'
    return `${scheme}://${document.host}${document.basePath ?? ''}`
  }
  throw new Error('OpenAPI document has no HTTP server URL')
}

function buildCall(
  method: string,
  path: string,
  basePath: string,
  operation: Operation,
  names: Set<string>,
  extracted: Set<string>
): { call: HttpCall; produced: string[] } {
  const parameters = operation.parameters ?? []
  const pathParams = new Map(parameters.filter((item) => item.in === 'path').map((item) => [item.name ?? '', item]))
  const concretePath = path.replace(/\{([^}]+)\}/g, (_match, name: string) => {
    if (extracted.has(name)) return `\${${name}}`
    return encodeURIComponent(exampleForParam(pathParams.get(name)))
  })
  const query = parameters
    .filter((item) => item.in === 'query' && item.required)
    .map((item) => `${encodeURIComponent(item.name ?? '')}=${encodeURIComponent(exampleForParam(item))}`)
  const suffix = query.length > 0 ? `?${query.join('&')}` : ''
  const joined = `${basePath}${concretePath.startsWith('/') ? concretePath : `/${concretePath}`}${suffix}`
  const body = requestBody(operation)
  const label = operation.operationId || operation.summary || `${method.toUpperCase()} ${path}`
  const produced = responseVariables(operation)
  const call: HttpCall = {
    name: uniqueName(names, label),
    method: method.toUpperCase(),
    path: joined || '/',
    body: body.text,
    contentType: body.contentType,
    requiresBody: body.required && body.text == null,
    assertions: [{ type: 'status', expected: successStatus(operation) }],
    extractors: produced.map((name) => ({
      name,
      source: 'json' as const,
      expression: `$.${name}`,
      matchNumber: 1,
      defaultValue: 'NOT_FOUND'
    }))
  }
  return { call, produced }
}

function requestBody(operation: Operation): { text?: string; contentType?: string; required: boolean } {
  const body = operation.requestBody
  if (!body) return { required: false }
  const json = body.content?.['application/json']
  if (json) {
    const example = mediaExample(json.example, json.examples, json.schema)
    if (example === undefined) return { required: Boolean(body.required), contentType: 'application/json' }
    return { text: JSON.stringify(example), contentType: 'application/json', required: false }
  }
  const form = body.content?.['application/x-www-form-urlencoded']
  if (form) {
    const example = mediaExample(form.example, form.examples, form.schema)
    if (example && typeof example === 'object') {
      const params = new URLSearchParams()
      for (const [key, value] of Object.entries(example as Record<string, unknown>)) params.set(key, String(value ?? ''))
      return { text: params.toString(), contentType: 'application/x-www-form-urlencoded', required: false }
    }
  }
  return { required: Boolean(body.required) }
}

function mediaExample(
  example: unknown,
  examples: Record<string, { value?: unknown }> | undefined,
  schema: JsonSchema | undefined
): unknown {
  if (example !== undefined) return example
  const first = examples ? Object.values(examples).find((item) => item.value !== undefined) : undefined
  if (first?.value !== undefined) return first.value
  return exampleFromSchema(schema)
}

function successStatus(operation: Operation): string {
  const codes = Object.keys(operation.responses ?? {}).filter((code) => /^2\d\d$/.test(code)).sort()
  return codes[0] ?? '200'
}

function responseVariables(operation: Operation): string[] {
  const response = operation.responses?.[successStatus(operation)]
  const json = response?.content?.['application/json']
  const example = json ? mediaExample(json.example, undefined, json.schema) : undefined
  const names: string[] = []
  if (example && typeof example === 'object' && !Array.isArray(example)) {
    for (const key of ['id', 'token', 'access_token']) {
      if (key in (example as Record<string, unknown>)) names.push(key)
    }
  }
  const properties = json?.schema?.properties
  if (properties) {
    for (const key of ['id', 'token', 'access_token']) {
      if (properties[key] && !names.includes(key)) names.push(key)
    }
  }
  return names
}

function exampleForParam(parameter: Parameter | undefined): string {
  if (!parameter) return '1'
  if (parameter.example != null) return String(parameter.example)
  const schema = parameter.schema
  if (schema?.example != null) return String(schema.example)
  if (schema?.default != null) return String(schema.default)
  if (schema?.enum && schema.enum.length > 0) return String(schema.enum[0])
  if (schema?.type === 'integer' || schema?.type === 'number') return '1'
  if (schema?.type === 'boolean') return 'true'
  return 'sample'
}

function exampleFromSchema(schema: JsonSchema | undefined, depth = 0): unknown {
  if (!schema || depth > 6) return undefined
  if (schema.example !== undefined) return schema.example
  if (schema.default !== undefined) return schema.default
  if (schema.enum && schema.enum.length > 0) return schema.enum[0]
  if (schema.allOf && schema.allOf.length > 0) {
    return Object.assign({}, ...schema.allOf.map((item) => exampleFromSchema(item, depth + 1)))
  }
  if (schema.oneOf?.[0]) return exampleFromSchema(schema.oneOf[0], depth + 1)
  if (schema.anyOf?.[0]) return exampleFromSchema(schema.anyOf[0], depth + 1)
  if (schema.type === 'string') {
    if (schema.format === 'date-time') return '2024-01-01T00:00:00.000Z'
    if (schema.format === 'date') return '2024-01-01'
    if (schema.format === 'uuid') return '00000000-0000-4000-8000-000000000001'
    if (schema.format === 'email') return 'user@example.com'
    return 'sample'
  }
  if (schema.type === 'integer' || schema.type === 'number') return 1
  if (schema.type === 'boolean') return true
  if (schema.type === 'array') return [exampleFromSchema(schema.items, depth + 1)]
  if (schema.type === 'object' || schema.properties) {
    const result: Record<string, unknown> = {}
    const required = new Set(schema.required ?? [])
    for (const [key, value] of Object.entries(schema.properties ?? {})) {
      if (required.size === 0 || required.has(key)) result[key] = exampleFromSchema(value, depth + 1)
    }
    return result
  }
  return undefined
}

function authFromSecurity(requirements: Record<string, string[]>[] | undefined, schemes: Record<string, SecurityScheme>): Auth {
  for (const requirement of requirements ?? []) {
    for (const name of Object.keys(requirement)) {
      const scheme = schemes[name]
      if (!scheme) continue
      const type = String(scheme.type ?? '').toLowerCase()
      const httpScheme = String(scheme.scheme ?? '').toLowerCase()
      if (type === 'http' && httpScheme === 'basic') return { type: 'basic' }
      if (type === 'http' && httpScheme === 'bearer') return { type: 'bearer', tokenVar: 'token', headerName: 'Authorization', headerPrefix: 'Bearer ' }
      if (type === 'apikey' || type === 'apiKey'.toLowerCase()) {
        if (String(scheme.in ?? 'header').toLowerCase() === 'header' && scheme.name) {
          return { type: 'bearer', tokenVar: 'token', headerName: scheme.name, headerPrefix: '' }
        }
      }
    }
  }
  return { type: 'none' }
}

export function intakePostman(collection: PostmanCollection, config: AppConfig): IntakeDraft {
  const requests: { name: string; request: PostmanRequest }[] = []
  const walk = (items: PostmanItem[] | undefined): void => {
    for (const item of items ?? []) {
      if (item.request) requests.push({ name: item.name || item.request.method || 'request', request: item.request })
      if (item.item) walk(item.item)
    }
  }
  walk(collection.item)
  if (requests.length === 0) throw new Error('Postman collection has no requests')

  const names = new Set<string>()
  const calls: HttpCall[] = []
  let baseUrl = ''
  for (const item of requests) {
    if (calls.length >= MAX_OPERATIONS) break
    const raw = typeof item.request.url === 'string' ? item.request.url : item.request.url?.raw
    if (!raw || !/^https?:\/\//i.test(raw)) {
      throw new Error('Postman requests must use absolute http(s) URLs')
    }
    const url = assertAllowedUrl(raw, config.allowedHosts)
    if (!baseUrl) baseUrl = url.origin
    if (url.origin !== baseUrl) continue
    const headers: Record<string, string> = {}
    for (const header of item.request.header ?? []) {
      if (!header.key || header.disabled) continue
      headers[header.key] = header.value ?? ''
    }
    const body = item.request.body?.mode === 'raw' ? item.request.body.raw : undefined
    calls.push({
      name: uniqueName(names, item.name),
      method: (item.request.method || 'GET').toUpperCase(),
      path: `${url.pathname}${url.search}`,
      headers,
      body,
      assertions: [{ type: 'status', expected: '200' }]
    })
  }
  if (calls.length === 0) throw new Error('Postman collection has no requests on an allowed host')
  return {
    notes: [],
    model: {
      name: collection.info?.name || 'Postman performance test',
      baseUrl,
      auth: { type: 'none' },
      scenarios: [{ name: 'Collection', calls }],
      load: defaultLoad(config)
    }
  }
}
