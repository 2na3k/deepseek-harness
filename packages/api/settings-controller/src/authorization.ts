/** Host Remote bridge for human-guided credential authorization flows. */

import { randomUUID } from 'node:crypto'
import { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import { AuthorizationError } from '@deepseek-ai/dsh-authorization'
import type { AuthorizationInteraction } from '@deepseek-ai/dsh-authorization'
import type { AuthorizationNotice, AuthorizationPrompt } from '@deepseek-ai/dsh-authorization/types'
import { parseCredentialKey } from '@deepseek-ai/dsh-credentials'
import type { CredentialKey } from '@deepseek-ai/dsh-credentials'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import { z } from 'zod'
import type {
  AuthorizationAttemptId, AuthorizationFrame, AuthorizationPromptId, AuthorizationProviderView,
} from './types.ts'

const keySchema = z.string().regex(/^[a-z][a-z0-9-]*\/[a-z][a-z0-9-]*$/)
const answerSchema = z.string().max(8192)
const MAX_PENDING_FRAMES = 64

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Host owner of the `authorization` Remote namespace. */
    authorizationController: AuthorizationController
  }
}

interface PendingPrompt {
  readonly prompt: AuthorizationPrompt
  readonly resolve: (answer: string) => void
  readonly reject: (error: Error) => void
  readonly abort?: () => void
}

interface Attempt {
  readonly id: AuthorizationAttemptId
  readonly key: CredentialKey
  readonly controller: AbortController
  readonly frames: AuthorizationFrame[]
  readonly waiters: Set<() => void>
  readonly prompts: Map<string, PendingPrompt>
  done: boolean
  run: Promise<void>
}

/**
 * Host service backing `ctx.remote.authorization`; grants and prompt answers
 * remain in the Host process while safe interaction frames cross the Remote.
 */
export class AuthorizationController extends TypertRemoteService {
  private readonly attempts = new Map<string, Attempt>()

  /** @param ctx - Host with authorization and credential services. */
  constructor(ctx: Context) {
    super(ctx, 'authorizationController', { namespace: 'authorization' })
    ctx.effect(() => async () => {
      const attempts = [...this.attempts.values()]
      for (const attempt of attempts) this.stop(attempt)
      await Promise.all(attempts.map(attempt => attempt.run))
      this.attempts.clear()
    }, 'authorization Remote attempts')
  }

  /**
   * List available flows and safe credential facts for a settings surface.
   * @returns registered flows with no grant payloads or token values.
   */
  @Remote
  async list(): Promise<AuthorizationProviderView[]> {
    const authorization = this.ctx.get('authorization')
    const credentials = this.ctx.get('credentials')
    if (authorization === undefined || credentials === undefined) {
      throw new RemoteError('gateway/internal', 'authorization or credentials service is absent', {})
    }
    return Promise.all(authorization.list().map(async (entry) => {
      const info = await credentials.describeRecord(entry.key)
      return {
        key: entry.key,
        label: entry.label,
        methods: entry.methods.map(method => ({ id: method.id, label: method.label })),
        inFlight: entry.inFlight,
        credential: {
          configured: info.configured,
          ...info.kind === undefined ? {} : { kind: info.kind },
          writable: info.writable,
        },
      }
    }))
  }

  /**
   * Start one authorization and stream its notices, prompts, and outcome.
   * @param key - registered credential key.
   * @param method - optional method offered by that flow.
   * @param signal - Remote stream lifetime; closing the stream cancels the attempt.
   * @returns safe frames until the attempt settles.
   */
  @Remote({ mode: 'stream' })
  async *begin(key: string, method: string | undefined, signal: AbortSignal): AsyncIterable<AuthorizationFrame> {
    if (signal.aborted) return
    const parsed = parseKey(key)
    const authorization = this.ctx.get('authorization')
    if (authorization === undefined) {
      throw new RemoteError('gateway/internal', 'authorization service is absent', {})
    }
    const attempt: Attempt = {
      id: brandString<AuthorizationAttemptId>(randomUUID()), key: parsed, controller: new AbortController(),
      frames: [], waiters: new Set(), prompts: new Map(), done: false,
      run: Promise.resolve(),
    }
    this.attempts.set(attempt.id, attempt)
    this.publish(attempt, { type: 'started', attemptId: attempt.id })
    const interaction: AuthorizationInteraction = {
      notify: (notice) => { this.publish(attempt, { type: 'notice', notice: safeNotice(notice) }) },
      prompt: prompt => this.ask(attempt, prompt),
    }
    attempt.run = authorization.begin({
      key: parsed, ...method === undefined ? {} : { method }, interaction, signal: attempt.controller.signal,
    }).then(
      (outcome) => { this.publish(attempt, { type: 'settled', outcome }) },
      (error: unknown) => {
        this.publish(attempt, {
          type: 'settled',
          outcome: { status: 'failed', message: safeFailure(error) },
        })
      },
    ).finally(() => {
      attempt.done = true
      this.wake(attempt)
    })
    const close = (): void => { this.stop(attempt) }
    signal.addEventListener('abort', close, { once: true })
    try {
      while (true) {
        while (attempt.frames.length > 0) {
          const frame = attempt.frames.shift()
          if (frame !== undefined) yield frame
        }
        if (attempt.done) return
        await this.wait(attempt)
      }
    } finally {
      signal.removeEventListener('abort', close)
      if (!attempt.done) this.stop(attempt)
      await attempt.run
      this.attempts.delete(attempt.id)
    }
  }

  /**
   * Answer the active prompt for an attempt.
   * @param attemptId - id emitted by the attempt's `started` frame.
   * @param promptId - id emitted by the corresponding `prompt` frame.
   * @param answer - typed text or selected option id.
   * @throws RemoteError when the prompt is absent or the answer is invalid.
   */
  @Remote
  respond(attemptId: AuthorizationAttemptId, promptId: AuthorizationPromptId, answer: string): void {
    const attempt = this.attempt(attemptId)
    const pending = attempt.prompts.get(promptId)
    const parsed = answerSchema.safeParse(answer)
    if (pending === undefined || !parsed.success) {
      throw new RemoteError('gateway/bad-request', 'authorization prompt is absent or the answer is invalid', {})
    }
    if (pending.prompt.kind === 'select' && !pending.prompt.options.some(option => option.id === parsed.data)) {
      throw new RemoteError('gateway/bad-request', 'authorization choice is not offered by the prompt', {})
    }
    this.finishPrompt(attempt, promptId)
    pending.resolve(parsed.data)
  }

  /**
   * Cancel an active authorization attempt.
   * @param attemptId - id emitted by the attempt's `started` frame.
   */
  @Remote
  cancel(attemptId: AuthorizationAttemptId): void {
    this.stop(this.attempt(attemptId))
  }

  /**
   * Remove a stored credential without exposing its payload.
   * @param key - registered credential key to clear.
   */
  @Remote
  async clear(key: string): Promise<void> {
    const parsed = parseKey(key)
    const authorization = this.ctx.get('authorization')
    if (authorization?.describe(parsed) === undefined) {
      throw new RemoteError('gateway/bad-request', 'no authorization flow is registered for this credential key', {})
    }
    const attempts = [...this.attempts.values()].filter(candidate => candidate.key === parsed)
    for (const attempt of attempts) this.stop(attempt)
    if (attempts.length > 0) {
      await Promise.all(attempts.map(attempt => attempt.run))
    }
    const credentials = this.ctx.get('credentials')
    if (credentials === undefined) throw new RemoteError('gateway/internal', 'credentials service is absent', {})
    await credentials.deleteRecord(parsed)
  }

  private attempt(id: string): Attempt {
    const parsed = z.uuid().safeParse(id)
    const attempt = parsed.success ? this.attempts.get(parsed.data) : undefined
    if (attempt === undefined || attempt.done) {
      throw new RemoteError('gateway/bad-request', 'authorization attempt is no longer active', {})
    }
    return attempt
  }

  private ask(attempt: Attempt, prompt: AuthorizationPrompt): Promise<string> {
    const promptId = randomUUID()
    return new Promise<string>((resolve, reject) => {
      const abort = prompt.signal === undefined ? undefined : (): void => {
        this.finishPrompt(attempt, promptId)
        this.publish(attempt, {
          type: 'prompt-withdrawn', attemptId: attempt.id, promptId: brandString<AuthorizationPromptId>(promptId),
        })
        reject(new Error('authorization prompt was withdrawn'))
      }
      const pending: PendingPrompt = { prompt, resolve, reject, ...abort === undefined ? {} : { abort } }
      attempt.prompts.set(promptId, pending)
      if (abort !== undefined) prompt.signal?.addEventListener('abort', abort, { once: true })
      this.publish(attempt, {
        type: 'prompt', attemptId: attempt.id, promptId: brandString<AuthorizationPromptId>(promptId), prompt: safePrompt(prompt),
      })
      if (prompt.signal?.aborted) abort?.()
    })
  }

  private finishPrompt(attempt: Attempt, promptId: string): PendingPrompt | undefined {
    const pending = attempt.prompts.get(promptId)
    if (pending === undefined) return undefined
    attempt.prompts.delete(promptId)
    if (pending.abort !== undefined) pending.prompt.signal?.removeEventListener('abort', pending.abort)
    return pending
  }

  private stop(attempt: Attempt): void {
    attempt.controller.abort()
    for (const [promptId, pending] of attempt.prompts) {
      this.finishPrompt(attempt, promptId)
      this.publish(attempt, {
        type: 'prompt-withdrawn', attemptId: attempt.id, promptId: brandString<AuthorizationPromptId>(promptId),
      })
      pending.reject(new Error('authorization attempt was cancelled'))
    }
    this.wake(attempt)
  }

  private publish(attempt: Attempt, frame: AuthorizationFrame): void {
    if (attempt.done) return
    if (attempt.frames.length >= MAX_PENDING_FRAMES && frame.type !== 'settled') {
      attempt.controller.abort()
      for (const [promptId, pending] of attempt.prompts) {
        this.finishPrompt(attempt, promptId)
        pending.reject(new Error('authorization interaction exceeded its pending-frame limit'))
      }
      attempt.frames.length = 0
      attempt.done = true
      attempt.frames.push({ type: 'settled', outcome: { status: 'failed', message: 'Authorization produced too many updates. Try again.' } })
      this.wake(attempt)
      return
    }
    attempt.frames.push(frame)
    this.wake(attempt)
  }

  private wake(attempt: Attempt): void {
    for (const resolve of attempt.waiters) resolve()
    attempt.waiters.clear()
  }

  private wait(attempt: Attempt): Promise<void> {
    return new Promise((resolve) => { attempt.waiters.add(resolve) })
  }
}

function parseKey(key: string): CredentialKey {
  const parsed = keySchema.safeParse(key)
  if (!parsed.success) throw new RemoteError('gateway/bad-request', 'invalid authorization credential key', {})
  return parseCredentialKey(parsed.data)
}

function safeNotice(notice: AuthorizationNotice): AuthorizationNotice {
  return {
    message: notice.message,
    ...notice.url === undefined ? {} : { url: notice.url },
    ...notice.code === undefined ? {} : { code: notice.code },
  }
}

function safePrompt(prompt: AuthorizationPrompt): import('./types.ts').AuthorizationPromptView {
  switch (prompt.kind) {
    case 'select':
      return { kind: prompt.kind, message: prompt.message, options: prompt.options.map(option => ({
        id: option.id, label: option.label, ...option.description === undefined ? {} : { description: option.description },
      })) }
    case 'secret':
    case 'text':
      return { kind: prompt.kind, message: prompt.message, ...prompt.placeholder === undefined ? {} : { placeholder: prompt.placeholder } }
    default:
      return assertNever(prompt, 'AuthorizationPrompt')
  }
}

function safeFailure(error: unknown): string {
  if (error instanceof AuthorizationError) return `Authorization failed (${error.code}).`
  return 'Authorization failed. Try again.'
}
