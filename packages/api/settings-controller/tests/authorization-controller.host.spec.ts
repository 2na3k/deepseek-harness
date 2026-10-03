import { describe, expect, it, onTestFinished } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { AuthorizationService } from '@deepseek-ai/dsh-authorization'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import { remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import { MemoryCredentials } from '../../../credentials/credentials/tests/memory.ts'
import { AuthorizationController } from '../src/authorization.ts'
import type { AuthorizationFrame } from '../src/types.ts'

const KEY = credentialKey('llm-pi-ai', 'openai-codex')

async function boot() {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(MemoryCredentials)
  await ctx.plugin(AuthorizationService)
  await ctx.plugin(AuthorizationController)
  return { ctx, controller: ctx.authorizationController }
}

async function nextFrame(iterator: AsyncGenerator<AuthorizationFrame, void, unknown>): Promise<AuthorizationFrame> {
  const result = await iterator.next()
  if (result.done) throw new Error('authorization stream ended before its next frame')
  return result.value
}

function frameIterator(stream: AsyncIterable<AuthorizationFrame>): AsyncGenerator<AuthorizationFrame, void, unknown> {
  return (async function* () {
    for await (const frame of stream) yield frame
  })()
}

class CommitBarrierCredentials extends MemoryCredentials {
  readonly entered = Promise.withResolvers<undefined>()
  readonly release = Promise.withResolvers<undefined>()
  holdNextWrite = false

  override async modifyRecord(
    key: Parameters<MemoryCredentials['modifyRecord']>[0],
    mutate: Parameters<MemoryCredentials['modifyRecord']>[1],
  ): ReturnType<MemoryCredentials['modifyRecord']> {
    if (this.holdNextWrite) {
      this.holdNextWrite = false
      this.entered.resolve(undefined)
      await this.release.promise
    }
    return super.modifyRecord(key, mutate)
  }
}

describe('authorization Remote', () => {
  it('publishes safe flow and credential views', async () => {
    const { ctx, controller } = await boot()
    ctx.authorization.registerFlow({
      key: KEY,
      label: 'ChatGPT (Codex)',
      methods: [{ id: 'oauth', label: 'Sign in with ChatGPT' }],
      run: async (session) => { await session.commit({ kind: 'grant', payload: { access: 'private-token' } }) },
    })
    await ctx.credentials.modifyRecord(KEY, () => Promise.resolve({ kind: 'grant', payload: { access: 'private-token' } }))

    expect(controller.typertRemote.namespace).toBe('authorization')
    expect(remoteMethods(controller).map(method => method.method)).toEqual(['list', 'begin', 'respond', 'cancel', 'clear'])
    const entries = await controller.list()
    expect(entries).toEqual([{
      key: KEY,
      label: 'ChatGPT (Codex)',
      methods: [{ id: 'oauth', label: 'Sign in with ChatGPT' }],
      inFlight: false,
      credential: { configured: true, kind: 'grant', writable: true },
    }])
    expect(JSON.stringify(entries)).not.toContain('private-token')
  })

  it('streams notices and prompts, validates answers, and stores only through the authorization seam', async () => {
    const { ctx, controller } = await boot()
    ctx.authorization.registerFlow({
      key: KEY,
      label: 'ChatGPT (Codex)',
      methods: [{ id: 'oauth', label: 'Sign in with ChatGPT' }],
      run: async (session) => {
        session.notify({ message: 'Continue in your browser', url: 'https://auth.example/start' })
        const choice = await session.prompt({ kind: 'select', message: 'Choose an account', options: [{ id: 'account-a', label: 'Account A' }] })
        await session.commit({ kind: 'grant', payload: { account: choice, access: 'cached-secret' } })
      },
    })

    const iterator = frameIterator(controller.begin(KEY, 'oauth', new AbortController().signal))
    const started = await nextFrame(iterator)
    if (started.type !== 'started') throw new Error('authorization did not start')
    expect(await nextFrame(iterator)).toEqual({
      type: 'notice', notice: { message: 'Continue in your browser', url: 'https://auth.example/start' },
    })
    const prompt = await nextFrame(iterator)
    if (prompt.type !== 'prompt') throw new Error('authorization did not ask for a choice')
    expect(() => { controller.respond(started.attemptId, prompt.promptId, 'other') })
      .toThrow(expect.objectContaining({ code: 'gateway/bad-request' }))
    controller.respond(started.attemptId, prompt.promptId, 'account-a')
    expect(await nextFrame(iterator)).toEqual({ type: 'settled', outcome: { status: 'authorized' } })
    expect((await iterator.next()).done).toBe(true)
    expect(await ctx.credentials.readRecord(KEY)).toEqual({
      kind: 'grant', payload: { account: 'account-a', access: 'cached-secret' },
    })
  })

  it('waits for cancellation to settle and rejects clearing a key without a registered flow', async () => {
    const { ctx, controller } = await boot()
    ctx.authorization.registerFlow({
      key: KEY,
      label: 'ChatGPT (Codex)',
      methods: [{ id: 'oauth', label: 'Sign in with ChatGPT' }],
      run: async (session) => {
        await session.prompt({ kind: 'text', message: 'Code' })
        await session.commit({ kind: 'grant', payload: { access: 'should-not-store' } })
      },
    })
    await ctx.credentials.modifyRecord(KEY, () => Promise.resolve({ kind: 'grant', payload: { access: 'old' } }))
    const iterator = frameIterator(controller.begin(KEY, 'oauth', new AbortController().signal))
    const started = await nextFrame(iterator)
    if (started.type !== 'started') throw new Error('authorization did not start')
    const prompt = await nextFrame(iterator)
    if (prompt.type !== 'prompt') throw new Error('authorization did not ask for a code')
    await iterator.return?.()
    expect(await ctx.credentials.readRecord(KEY)).toEqual({ kind: 'grant', payload: { access: 'old' } })
    await expect(controller.clear('llm-pi-ai/not-registered')).rejects.toMatchObject({ code: 'gateway/bad-request' })
    const settled = await controller.list()
    expect(settled[0]?.inFlight).toBe(false)
  })

  it('withdraws a raced prompt and keeps a duplicate begin from cancelling its owner', async () => {
    const { ctx, controller } = await boot()
    let calls = 0
    ctx.authorization.registerFlow({
      key: KEY,
      label: 'ChatGPT (Codex)',
      methods: [{ id: 'oauth', label: 'Sign in with ChatGPT' }],
      run: async (session) => {
        calls++
        if (calls === 1) {
          const prompt = await session.prompt({ kind: 'text', message: 'Authorization code' })
          await session.commit({ kind: 'grant', payload: { answer: prompt } })
          return
        }
        const abort = new AbortController()
        const pending = session.prompt({
          kind: 'select', message: 'Temporary account', options: [{ id: 'temporary', label: 'Temporary' }], signal: abort.signal,
        })
        abort.abort()
        await pending.catch(() => undefined)
        await session.commit({ kind: 'grant', payload: { access: 'second' } })
      },
    })

    const first = frameIterator(controller.begin(KEY, 'oauth', new AbortController().signal))
    const firstStarted = await nextFrame(first)
    if (firstStarted.type !== 'started') throw new Error('first authorization did not start')
    const firstPrompt = await nextFrame(first)
    if (firstPrompt.type !== 'prompt') throw new Error('first authorization did not prompt')

    const second = frameIterator(controller.begin(KEY, 'oauth', new AbortController().signal))
    await nextFrame(second)
    expect(await nextFrame(second)).toMatchObject({
      type: 'settled', outcome: { status: 'failed', message: 'Authorization failed (ALREADY_IN_FLIGHT).' },
    })
    expect((await controller.list())[0]?.inFlight).toBe(true)

    // Answer the first prompt. Its own stream and stored record remain intact.
    controller.respond(firstStarted.attemptId, firstPrompt.promptId, 'code')
    expect(await nextFrame(first)).toEqual({ type: 'settled', outcome: { status: 'authorized' } })
    await first.next()
    expect(await ctx.credentials.readRecord(KEY)).toEqual({ kind: 'grant', payload: { answer: 'code' } })

    // A flow may withdraw one prompt without cancelling its whole attempt.
    const third = frameIterator(controller.begin(KEY, 'oauth', new AbortController().signal))
    await nextFrame(third)
    expect(await nextFrame(third)).toMatchObject({ type: 'prompt', prompt: { kind: 'select' } })
    expect(await nextFrame(third)).toMatchObject({ type: 'prompt-withdrawn' })
    expect(await nextFrame(third)).toMatchObject({ type: 'settled', outcome: { status: 'authorized' } })
    await third.next()
  })

  it('aborts and fails a flow that exceeds the pending-frame limit', async () => {
    const { ctx, controller } = await boot()
    let flowSignal: AbortSignal | undefined
    ctx.authorization.registerFlow({
      key: KEY,
      label: 'ChatGPT (Codex)',
      methods: [{ id: 'oauth', label: 'Sign in with ChatGPT' }],
      run: async (session) => {
        flowSignal = session.signal
        for (let index = 0; index < 80; index++) {
          session.notify({ message: `Progress ${index}` })
        }
        if (!session.signal.aborted) {
          await session.commit({ kind: 'grant', payload: { access: 'must-not-be-stored' } })
        }
      },
    })

    const iterator = frameIterator(controller.begin(KEY, 'oauth', new AbortController().signal))
    expect(await nextFrame(iterator)).toEqual({
      type: 'settled',
      outcome: { status: 'failed', message: 'Authorization produced too many updates. Try again.' },
    })
    expect((await iterator.next()).done).toBe(true)
    expect(flowSignal?.aborted).toBe(true)
    expect(await ctx.credentials.readRecord(KEY)).toBeUndefined()
  })

  it('waits for an admitted credential commit before clearing the record', async () => {
    const ctx = new Context()
    onTestFinished(() => ctx.fiber.dispose())
    await ctx.plugin(CommitBarrierCredentials)
    const store = ctx.get('credentials')
    if (!(store instanceof CommitBarrierCredentials)) throw new Error('test credential provider did not mount')
    await ctx.plugin(AuthorizationService)
    await ctx.plugin(AuthorizationController)
    let calls = 0
    ctx.authorization.registerFlow({
      key: KEY,
      label: 'ChatGPT (Codex)',
      methods: [{ id: 'oauth', label: 'Sign in with ChatGPT' }],
      run: async (session) => {
        calls++
        await session.commit({ kind: 'grant', payload: { access: calls === 1 ? 'old' : 'committing' } })
      },
    })

    const firstSettled = Promise.withResolvers<undefined>()
    const stop = ctx.on('authorization/settled', (key) => { if (key === KEY) firstSettled.resolve(undefined) })
    const earlier = frameIterator(ctx.authorizationController.begin(KEY, 'oauth', new AbortController().signal))
    await nextFrame(earlier)
    await firstSettled.promise

    store.holdNextWrite = true
    const current = frameIterator(ctx.authorizationController.begin(KEY, 'oauth', new AbortController().signal))
    await nextFrame(current)
    await store.entered.promise
    let cleared = false
    const clear = ctx.authorizationController.clear(KEY).then(() => { cleared = true })
    await Promise.resolve()
    expect(cleared).toBe(false)
    store.release.resolve(undefined)
    await clear
    stop()
    expect(cleared).toBe(true)
    expect(await store.readRecord(KEY)).toBeUndefined()
    await earlier.next()
    await current.next()
  })
})
