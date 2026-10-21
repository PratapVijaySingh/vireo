import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { AppConfig } from '../config'
import { assertAllowedUrl } from '../security/allowlist'
import { intakeHar, type IntakeDraft } from './har'

export interface JourneyRequest {
  url: string
  steps?: string
}

export function splitSteps(steps: string | undefined): string[] {
  if (!steps) return []
  return steps
    .split(/\s*(?:\n+|(?:\bthen\b)|;\s*)/i)
    .map((step) => step.trim())
    .filter(Boolean)
}

export async function intakeJourney(request: JourneyRequest, config: AppConfig, workDir: string): Promise<IntakeDraft> {
  const target = assertAllowedUrl(request.url, config.allowedHosts)
  const harPath = join(workDir, 'journey.har')
  await recordJourney(target, splitSteps(request.steps), harPath)
  const har = JSON.parse(await readFile(harPath, 'utf8')) as unknown
  const draft = intakeHar(har, config)
  draft.notes.unshift(`Recorded journey from ${target.origin}`)
  if (!draft.model.name || draft.model.name === 'Recorded performance test') {
    draft.model.name = `Journey ${target.host}`
  }
  return draft
}

async function recordJourney(target: URL, steps: string[], harPath: string): Promise<void> {
  let browser: BrowserLike
  try {
    const playwright = await import('playwright')
    browser = await playwright.chromium.launch({ headless: true }) as unknown as BrowserLike
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (/Cannot find (package|module)|browserType\.launch|Executable doesn't exist|Please run the following command/i.test(message)) {
      throw new Error('Playwright Chromium is not installed. Run `npx playwright install chromium` to use journey intake.')
    }
    throw error
  }
  try {
    const context = await browser.newContext({
      recordHar: { path: harPath, content: 'embed' }
    })
    const page = await context.newPage()
    await page.goto(target.href, { waitUntil: 'domcontentloaded', timeout: 20000 })
    for (const step of steps) {
      await applyStep(page, step, target.origin)
    }
    await context.close()
  } finally {
    await browser.close()
  }
}

interface BrowserLike {
  newContext: (options: { recordHar: { path: string; content: 'embed' } }) => Promise<ContextLike>
  close: () => Promise<void>
}

interface ContextLike {
  newPage: () => Promise<PageLike>
  close: () => Promise<void>
}

interface PageLike {
  goto: (url: string, options: { waitUntil: 'domcontentloaded'; timeout: number }) => Promise<unknown>
  getByRole: (role: 'link' | 'button', options: { name: string }) => LocatorLike
  getByLabel: (text: string) => LocatorLike
  getByText: (text: string, options?: { exact: boolean }) => LocatorLike
}

interface LocatorLike {
  or: (other: LocatorLike) => LocatorLike
  first: () => LocatorLike
  click: (options: { timeout: number }) => Promise<void>
  fill: (value: string) => Promise<void>
}

export async function applyStep(page: PageLike, step: string, origin: string): Promise<void> {
  const click = /^(?:click|press|tap)\s+(?:on\s+)?["']?(.+?)["']?$/i.exec(step)
  if (click) {
    const name = click[1]
    await page.getByRole('link', { name }).or(page.getByRole('button', { name })).or(page.getByText(name)).first().click({ timeout: 8000 })
    return
  }

  const fill = /^(?:fill|type|enter)\s+["']?(.+?)["']?\s+(?:into|in)\s+["']?(.+?)["']?$/i.exec(step)
  if (fill) {
    await page.getByLabel(fill[2]).fill(fill[1])
    return
  }

  const visit = /^(?:go to|open|visit)\s+(\S+)$/i.exec(step)
  if (visit) {
    const next = new URL(visit[1], origin)
    if (next.origin !== origin) throw new Error(`Refusing to leave ${origin}`)
    await page.goto(next.href, { waitUntil: 'domcontentloaded', timeout: 20000 })
    return
  }

  await page.getByText(step, { exact: false }).first().click({ timeout: 8000 })
}
