/** The shipped Models UI drives Codex OAuth through the Host Remote and stores the grant in the profile credential file. */
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed, vi } from 'vitest'
import { launchWebScaffold, watchConsole, type WebScaffold } from './scaffold.ts'
import { openSettings, saveFailureShot, ZH_BROWSER_LOCALE } from './support.ts'

describe('web e2e: Codex subscription authorization', () => {
  let home: string
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), 'dsh-codex-authorization-'))
    await mkdir(join(home, 'profiles', 'scaffold'), { recursive: true })
    await writeFile(join(home, 'profiles', 'scaffold', 'cordis.patch.yml'), [
      '- id: llm-pi-ai',
      '  config:',
      '    providers:',
      '      openai-codex:',
      '        baseURL: https://chatgpt.example/backend-api',
      '        models:',
      '          - id: gpt-6-luna',
      '',
    ].join('\n'))
    scaffold = await launchWebScaffold({ harnessHome: home })
    browser = await chromium.launch()
    page = await browser.newPage({ viewport: { width: 1680, height: 1000 }, locale: ZH_BROWSER_LOCALE })
    tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
  }, 120_000)

  afterAll(async () => {
    vi.restoreAllMocks()
    try {
      await browser?.close()
    } finally {
      try {
        await scaffold?.close()
      } finally {
        if (home !== undefined) await rm(home, { recursive: true, force: true })
      }
    }
  })

  it('signs in through the real Codex callback, retains the grant, and signs out', async () => {
    onTestFailed(() => saveFailureShot(page, 'codex-authorization'))
    const originalFetch = globalThis.fetch
    const jwtPayload = Buffer.from(JSON.stringify({
      exp: Math.floor(Date.now() / 1000) + 3600,
      'https://api.openai.com/auth': { chatgpt_account_id: 'dsh-e2e-account' },
    })).toString('base64url')
    const accessToken = `header.${jwtPayload}.signature`
    const tokenExchange = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const requestUrl = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (requestUrl === 'https://auth.openai.com/oauth/token') {
        return new Response(JSON.stringify({
          access_token: accessToken,
          refresh_token: 'dsh-e2e-refresh',
          expires_in: 3600,
        }), { headers: { 'content-type': 'application/json' } })
      }
      return originalFetch(input, init)
    })

    const context = page.context()
    await context.route('https://auth.openai.com/oauth/authorize**', async (route) => {
      const authUrl = new URL(route.request().url())
      const state = authUrl.searchParams.get('state')
      const redirectUri = authUrl.searchParams.get('redirect_uri')
      if (state === null) throw new Error('Codex OAuth authorization URL omitted state')
      if (redirectUri !== 'http://localhost:1455/auth/callback') {
        throw new Error(`Unexpected Codex OAuth callback URL: ${redirectUri}`)
      }
      const callback = new URL(redirectUri)
      callback.searchParams.set('code', 'dsh-e2e-code')
      callback.searchParams.set('state', state)
      await route.fulfill({
        status: 200,
        contentType: 'text/html',
        body: `<script>window.location.replace(${JSON.stringify(callback.href)})</script>`,
      })
    })

    await openSettings(page, 'zh')
    const dialog = page.getByRole('dialog', { name: '设置' })
    await dialog.getByRole('button', { name: '模型', exact: true }).click()
    const edit = dialog.getByRole('button', { name: '编辑 openai-codex', exact: true })
    await edit.waitFor({ timeout: 10_000 })
    await edit.click()
    await dialog.getByText('自定义设置', { exact: true }).click()
    await dialog.getByRole('button', { name: '模型选项 1', exact: true }).click()
    const modelId = dialog.getByLabel('模型 ID 1', { exact: true })
    await modelId.waitFor({ state: 'visible' })
    expect(await modelId.inputValue()).toBe('gpt-6-luna')

    const continueButton = dialog.getByRole('button', { name: '使用 ChatGPT 继续', exact: true })
    await dialog.getByText('未登录', { exact: true }).waitFor({ state: 'visible' })
    await continueButton.click()
    await dialog.getByLabel('Select OpenAI Codex login method:').waitFor({ timeout: 10_000 })
    await dialog.getByRole('button', { name: '继续', exact: true }).click()
    const popupPromise = page.waitForEvent('popup')
    await dialog.getByRole('link', { name: '打开登录页面', exact: true }).click()
    const popup = await popupPromise
    await popup.waitForURL('http://localhost:1455/auth/callback**', { timeout: 10_000 })
    await dialog.getByText('已登录', { exact: true }).waitFor({ state: 'visible', timeout: 15_000 })
    expect(tokenExchange).toHaveBeenCalledTimes(1)
    expect(await readFile(join(home, '.credentials.yaml'), 'utf8')).toContain('dsh-e2e-refresh')
    expect(await readFile(join(home, '.credentials.yaml'), 'utf8')).toContain(accessToken)

    await popup.close()
    await page.reload({ waitUntil: 'load' })
    await openSettings(page, 'zh')
    await dialog.getByRole('button', { name: '模型', exact: true }).click()
    await dialog.getByRole('button', { name: '编辑 openai-codex', exact: true }).click()
    await dialog.getByText('已登录', { exact: true }).waitFor({ state: 'visible', timeout: 10_000 })
    const renderedPage = await page.locator('body').innerText()
    expect(renderedPage).not.toContain(accessToken)
    expect(renderedPage).not.toContain('dsh-e2e-refresh')
    const connectedScreenshot = process.env.DSH_CODEX_CONNECTED_SCREENSHOT
    if (connectedScreenshot !== undefined) await page.screenshot({ path: connectedScreenshot })

    await dialog.getByRole('button', { name: '退出登录', exact: true }).click()
    await dialog.getByText('未登录', { exact: true }).waitFor({ state: 'visible', timeout: 10_000 })
    const credentials = await readFile(join(home, '.credentials.yaml'), 'utf8')
    expect(credentials).not.toContain('dsh-e2e-refresh')
    expect(credentials).not.toContain(accessToken)
    expect(tripwire.pageErrors).toEqual([])
  }, 60_000)
})
