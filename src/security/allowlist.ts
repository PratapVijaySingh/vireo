const BLOCKED_HOSTS = new Set(['169.254.169.254', 'metadata.google.internal'])

export class TargetNotAllowedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TargetNotAllowedError'
  }
}

export function normalizeHost(entry: string): string {
  const trimmed = entry.trim().toLowerCase()
  if (!trimmed) return ''
  try {
    if (trimmed.includes('://')) return new URL(trimmed).hostname.toLowerCase()
  } catch {
    // Fall through and treat the entry as a hostname.
  }
  return trimmed.replace(/:\d+$/, '')
}

export function assertAllowedUrl(target: string, allowedHosts: string[]): URL {
  let url: URL
  try {
    url = new URL(target)
  } catch {
    throw new TargetNotAllowedError(`Target is not a valid URL: ${target}`)
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new TargetNotAllowedError(`Only http and https targets are allowed (${url.protocol})`)
  }

  const host = url.hostname.toLowerCase()
  if (BLOCKED_HOSTS.has(host)) {
    throw new TargetNotAllowedError(`Refusing link-local or metadata host ${host}`)
  }

  const allowed = new Set(allowedHosts.map(normalizeHost).filter(Boolean))
  if (!allowed.has(host)) {
    throw new TargetNotAllowedError(`Host ${host} is not in ALLOWED_HOSTS`)
  }

  return url
}

export function originOf(target: string): string {
  const url = new URL(target)
  return `${url.protocol}//${url.host}`
}

export function stripUserInfo(target: string): { url: string; username?: string; password?: string } {
  const url = new URL(target)
  const username = url.username ? decodeURIComponent(url.username) : undefined
  const password = url.password ? decodeURIComponent(url.password) : undefined
  url.username = ''
  url.password = ''
  return { url: url.toString().replace(/\/$/, '') || url.origin, username, password }
}
