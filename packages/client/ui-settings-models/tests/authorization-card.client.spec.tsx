// @vitest-environment jsdom
/** Provider OAuth controls keep grants private while rendering human prompts. */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type {
  AuthorizationAttemptId, AuthorizationFrame, AuthorizationPromptId, AuthorizationProviderView,
} from '@deepseek-ai/dsh-api-remotes/client'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { ModelsOperations } from '../src/client/operations.ts'
import { AuthorizationCard } from '../src/client/AuthorizationCard.tsx'
import { en, zh } from '../src/client/locales.ts'

afterEach(cleanup)

const codex: AuthorizationProviderView = {
  key: brandString<AuthorizationProviderView['key']>('llm-pi-ai/openai-codex'),
  label: 'ChatGPT (Codex)',
  methods: [{ id: 'oauth', label: 'OAuth' }, { id: 'api-key', label: 'API key' }],
  inFlight: false,
  credential: { configured: false, writable: true },
}

function operations(overrides: Partial<ModelsOperations> = {}): ModelsOperations {
  return {
    beginAuthorization: vi.fn(async function* () {}),
    respondAuthorization: vi.fn(async () => undefined),
    cancelAuthorization: vi.fn(async () => undefined),
    clearAuthorization: vi.fn(async () => undefined),
    describeCredential: vi.fn(async () => undefined),
    storeCredential: vi.fn(async () => undefined),
    removeCredential: vi.fn(async () => undefined),
    writeSettings: vi.fn<ModelsOperations['writeSettings']>(async () => ({ kind: 'refused', message: '' })),
    discoverModels: vi.fn<ModelsOperations['discoverModels']>(async () => ({ kind: 'found', models: [] })),
    ...overrides,
  }
}

it('uses the ChatGPT label, lets the user choose the flow method, and answers a live prompt', async () => {
  let answerPrompt!: () => void
  const answered = new Promise<void>((resolve) => { answerPrompt = resolve })
  const beginAuthorization = vi.fn(async function* (_key: string, method: string | undefined): AsyncGenerator<AuthorizationFrame> {
    expect(method).toBe('oauth')
    yield { type: 'started', attemptId: brandString<AuthorizationAttemptId>('attempt-1') }
    yield { type: 'notice', notice: { message: 'Continue in the browser.', url: 'https://login.example' } }
    yield {
      type: 'prompt', attemptId: brandString<AuthorizationAttemptId>('attempt-1'),
      promptId: brandString<AuthorizationPromptId>('prompt-1'),
      prompt: { kind: 'select', message: 'Choose an account', options: [{ id: 'personal', label: 'Personal' }] },
    }
    await answered
    yield { type: 'settled', outcome: { status: 'authorized' } }
  })
  const respondAuthorization = vi.fn(async () => { answerPrompt(); return undefined })
  const onChanged = vi.fn()
  render(<AuthorizationCard authorization={codex} provider="openai-codex"
    operations={operations({ beginAuthorization, respondAuthorization })} t={key => en[key]} onChanged={onChanged} />)

  expect(screen.getByText(en.authNotConnected)).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Continue with ChatGPT' })).toBeTruthy()
  fireEvent.change(screen.getByLabelText(en.authMethod), { target: { value: 'oauth' } })
  const startButton = screen.getByRole('button', { name: 'Continue with ChatGPT' })
  act(() => { startButton.click(); startButton.click() })
  expect(beginAuthorization).toHaveBeenCalledTimes(1)
  await waitFor(() => { expect(screen.getByText('Continue in the browser.')).toBeTruthy() })
  expect(screen.getByRole('link', { name: en.openSignInPage }).getAttribute('href')).toBe('https://login.example')
  expect(screen.getByLabelText('Choose an account')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: en.continue }))
  await act(async () => { await answered })
  await waitFor(() => { expect(onChanged).toHaveBeenCalledTimes(1) })
  expect(respondAuthorization).toHaveBeenCalledWith('attempt-1', 'prompt-1', 'personal')
})

it('keeps failure copy localized and clears a stored grant on sign-out', async () => {
  const configured: AuthorizationProviderView = {
    ...codex,
    credential: { configured: true, kind: 'grant', writable: true },
  }
  const beginAuthorization = vi.fn(async function* (): AsyncGenerator<AuthorizationFrame> {
    yield { type: 'started', attemptId: brandString<AuthorizationAttemptId>('attempt-2') }
    yield { type: 'settled', outcome: { status: 'failed', message: 'provider diagnostic with private detail' } }
  })
  const clearAuthorization = vi.fn(async () => undefined)
  const onChanged = vi.fn()
  render(<AuthorizationCard authorization={configured} provider="openai-codex"
    operations={operations({ beginAuthorization, clearAuthorization })} t={key => zh[key]} onChanged={onChanged} />)

  expect(screen.getByText(zh.authConnected)).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: zh.continueWithChatGpt }))
  await waitFor(() => { expect(screen.getByRole('alert').textContent).toBe(zh.authorizationFailed) })
  expect(screen.queryByText('provider diagnostic with private detail')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: zh.signOut }))
  await waitFor(() => { expect(clearAuthorization).toHaveBeenCalledWith(codex.key) })
  expect(onChanged).toHaveBeenCalled()
})

it('keeps a prompt open after a refused answer and prevents duplicate submissions', async () => {
  const answerPrompt = Promise.withResolvers<undefined>()
  const beginAuthorization = vi.fn(async function* (): AsyncGenerator<AuthorizationFrame> {
    yield { type: 'started', attemptId: brandString<AuthorizationAttemptId>('attempt-3') }
    yield {
      type: 'prompt', attemptId: brandString<AuthorizationAttemptId>('attempt-3'),
      promptId: brandString<AuthorizationPromptId>('prompt-3'),
      prompt: { kind: 'text', message: 'Paste the authorization code' },
    }
    await answerPrompt.promise
    yield { type: 'settled', outcome: { status: 'authorized' } }
  })
  const respondAuthorization = vi.fn()
    .mockResolvedValueOnce('refused')
    .mockImplementationOnce(async () => { answerPrompt.resolve(undefined); return undefined })
  render(<AuthorizationCard authorization={codex} provider="openai-codex"
    operations={operations({ beginAuthorization, respondAuthorization })} t={key => en[key]} onChanged={vi.fn()} />)

  fireEvent.click(screen.getByRole('button', { name: en.continueWithChatGpt }))
  const input = await screen.findByLabelText('Paste the authorization code')
  fireEvent.change(input, { target: { value: 'code-value' } })
  const continueButton = screen.getByRole('button', { name: en.continue })
  fireEvent.click(continueButton)
  await waitFor(() => { expect(screen.getByRole('alert').textContent).toBe(en.authorizationFailed) })
  expect(screen.getByLabelText('Paste the authorization code')).toBeTruthy()
  fireEvent.click(continueButton)
  fireEvent.click(continueButton)
  await waitFor(() => { expect(respondAuthorization).toHaveBeenCalledTimes(2) })
  await waitFor(() => { expect(screen.queryByLabelText('Paste the authorization code')).toBeNull() })
})

it('cancels a live attempt without surfacing a late cancel refusal or labeling sign-out as cancel', async () => {
  const configured: AuthorizationProviderView = {
    ...codex,
    credential: { configured: true, kind: 'grant', writable: true },
  }
  const cleared = Promise.withResolvers<undefined>()
  const beginAuthorization = vi.fn(async function* (
    _key: string, _method: string | undefined, signal?: AbortSignal,
  ): AsyncGenerator<AuthorizationFrame> {
    yield { type: 'started', attemptId: brandString<AuthorizationAttemptId>('attempt-4') }
    await new Promise<void>((resolve) => { signal?.addEventListener('abort', () => { resolve() }, { once: true }) })
  })
  const cancelAuthorization = vi.fn(async () => { throw new Error('attempt already cancelled') })
  const clearAuthorization = vi.fn<ModelsOperations['clearAuthorization']>(() => cleared.promise)
  render(<AuthorizationCard authorization={configured} provider="openai-codex"
    operations={operations({ beginAuthorization, cancelAuthorization, clearAuthorization })}
    t={key => en[key]} onChanged={vi.fn()} />)

  fireEvent.click(screen.getByRole('button', { name: en.continueWithChatGpt }))
  const cancelButton = await screen.findByRole('button', { name: en.cancel })
  fireEvent.click(cancelButton)
  await waitFor(() => { expect(cancelAuthorization).toHaveBeenCalledWith('attempt-4') })
  await waitFor(() => { expect(screen.queryByRole('alert')).toBeNull() })

  fireEvent.click(screen.getByRole('button', { name: en.signOut }))
  expect(screen.queryByRole('button', { name: en.cancel })).toBeNull()
  expect(screen.getByRole('button', { name: en.signOut }).getAttribute('disabled')).not.toBeNull()
  await act(async () => { cleared.resolve(undefined); await cleared.promise })
})
