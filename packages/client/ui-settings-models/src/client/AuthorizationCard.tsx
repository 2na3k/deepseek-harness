/** Provider-owned sign-in and stored credential controls for one model route. */

import { useEffect, useRef, useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import type { AuthorizationFrame, AuthorizationProviderView } from '@deepseek-ai/dsh-api-remotes/client'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import type { ModelsOperations } from './operations.ts'
import type { en } from './locales.ts'
import styles from './ModelsSection.module.css'

type AttemptId = Extract<AuthorizationFrame, { type: 'started' }>['attemptId']

/** Props of {@link AuthorizationCard}. */
export interface AuthorizationCardProps {
  /** Registered flow and credential status, with secret data omitted. */
  authorization: AuthorizationProviderView
  /** Provider route whose card owns this flow. */
  provider: string
  /** Remote operations bound by the Models page. */
  operations: ModelsOperations
  /** Localized Models copy. */
  t: (key: keyof typeof en) => string
  /** Refresh credential status after an attempt or sign-out. */
  onChanged: () => void
}

/** Render one provider's sign-in flow and its current credential state. */
export function AuthorizationCard(props: AuthorizationCardProps): ReactNode {
  const { authorization, operations, t } = props
  const [methodChoice, setMethodChoice] = useState(() =>
    authorization.methods.find(candidate => candidate.id === 'oauth')?.id ?? authorization.methods[0]?.id ?? '')
  const [busy, setBusy] = useState(false)
  const [clearing, setClearing] = useState(false)
  const [answering, setAnswering] = useState(false)
  const [attemptId, setAttemptId] = useState<AttemptId | undefined>()
  const [notice, setNotice] = useState<{ message: string; url?: string; code?: string } | undefined>()
  const [prompt, setPrompt] = useState<Extract<AuthorizationFrame, { type: 'prompt' }> | undefined>()
  const [answer, setAnswer] = useState('')
  const [failure, setFailure] = useState<string | undefined>()
  const abort = useRef<AbortController | undefined>(undefined)
  const running = useRef(false)
  const answeringRef = useRef(false)

  useEffect(() => {
    if (prompt === undefined) { setAnswer(''); return }
    setAnswer(prompt.prompt.kind === 'select' ? prompt.prompt.options[0]?.id ?? '' : '')
  }, [prompt?.promptId])

  useEffect(() => () => { abort.current?.abort() }, [])

  const method = authorization.methods.some(candidate => candidate.id === methodChoice)
    ? methodChoice
    : authorization.methods.find(candidate => candidate.id === 'oauth')?.id
      ?? authorization.methods[0]?.id ?? ''

  const start = async (): Promise<void> => {
    if (busy || running.current || method.length === 0) return
    running.current = true
    const controller = new AbortController()
    abort.current = controller
    setBusy(true)
    setFailure(undefined)
    setNotice(undefined)
    setPrompt(undefined)
    setAttemptId(undefined)
    try {
      for await (const frame of operations.beginAuthorization(authorization.key, method, controller.signal)) {
        switch (frame.type) {
          case 'started':
            setAttemptId(frame.attemptId)
            break
          case 'notice':
            setNotice(frame.notice)
            break
          case 'prompt':
            setAttemptId(frame.attemptId)
            setPrompt(frame)
            break
          case 'prompt-withdrawn':
            setPrompt(current => current?.promptId === frame.promptId ? undefined : current)
            break
          case 'settled':
            setPrompt(undefined)
            setNotice(undefined)
            if (frame.outcome.status === 'failed') setFailure(t('authorizationFailed'))
            break
          default:
            assertNever(frame, 'Models authorization frame')
        }
      }
    } catch {
      if (!controller.signal.aborted) setFailure(t('authorizationFailed'))
    } finally {
      abort.current = undefined
      running.current = false
      setAttemptId(undefined)
      setBusy(false)
      props.onChanged()
    }
  }

  const cancel = (): void => {
    const id = attemptId
    abort.current?.abort()
    if (id !== undefined) void operations.cancelAuthorization(id).catch((error: unknown) => {
      // Closing the stream already owns cancellation; the Remote may settle before this redundant request.
      void error
    })
    setPrompt(undefined)
    setNotice(undefined)
    setFailure(undefined)
  }

  const respond = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    if (attemptId === undefined || prompt === undefined || answeringRef.current) return
    const submittedPromptId = prompt.promptId
    answeringRef.current = true
    setAnswering(true)
    try {
      const refusal = await operations.respondAuthorization(attemptId, prompt.promptId, answer)
      if (refusal !== undefined) setFailure(t('authorizationFailed'))
      else setPrompt(current => current?.promptId === submittedPromptId ? undefined : current)
    } catch {
      setFailure(t('authorizationFailed'))
    } finally {
      answeringRef.current = false
      setAnswering(false)
    }
  }

  const signOut = async (): Promise<void> => {
    setClearing(true)
    setFailure(undefined)
    try {
      const refusal = await operations.clearAuthorization(authorization.key)
      if (refusal !== undefined) setFailure(t('authorizationFailed'))
      else props.onChanged()
    } catch {
      setFailure(t('authorizationFailed'))
    } finally {
      setClearing(false)
    }
  }

  const oauthCodex = props.provider === 'openai-codex' && method === 'oauth'
  const actionLabel = oauthCodex
    ? t('continueWithChatGpt')
    : t(authorization.credential.configured ? 'signInAgain' : 'signIn')

  return (
    <section className={styles['authCard']} aria-label={authorization.label}>
      <div className={styles['authHeading']}>
        <span className={styles['fieldLabel']}>{authorization.label}</span>
        <span className={authorization.credential.configured ? styles['savedNotice'] : styles['advancedHint']}>
          {authorization.credential.configured ? t('authConnected') : t('authNotConnected')}
        </span>
      </div>
      {authorization.methods.length > 1
        ? <label className={styles['field']}>
          <span className={styles['fieldLabel']}>{t('authMethod')}</span>
          <select className={`${styles['input']} ${styles['selectInput']}`} value={method}
            aria-label={t('authMethod')} disabled={busy}
            onChange={(event) => {
              setMethodChoice(event.target.value); setPrompt(undefined); setNotice(undefined); setFailure(undefined)
            }}>
            {authorization.methods.map(candidate => <option key={candidate.id} value={candidate.id}>{candidate.label}</option>)}
          </select>
        </label>
        : null}
      {notice === undefined ? null : (
        <div className={styles['authNotice']} role="status">
          <span>{notice.message}</span>
          {notice.url === undefined ? null : <a href={notice.url} target="_blank" rel="noopener noreferrer">{t('openSignInPage')}</a>}
          {notice.code === undefined ? null : <code>{notice.code}</code>}
        </div>
      )}
      {prompt === undefined ? null : (
        <form className={styles['field']} onSubmit={(event) => { void respond(event) }}>
          <label className={styles['field']}>
            <span className={styles['fieldLabel']}>{prompt.prompt.message}</span>
            {prompt.prompt.kind === 'select'
              ? <select className={`${styles['input']} ${styles['selectInput']}`} value={answer}
                onChange={(event) => { setAnswer(event.target.value) }}>
                {prompt.prompt.options.map(option => <option key={option.id} value={option.id}>{option.label}</option>)}
              </select>
              : <input className={styles['input']} type={prompt.prompt.kind === 'secret' ? 'password' : 'text'}
                autoComplete={prompt.prompt.kind === 'secret' ? 'new-password' : 'off'}
                placeholder={prompt.prompt.placeholder} value={answer} onChange={(event) => { setAnswer(event.target.value) }} />}
          </label>
          <div className={styles['rowActions']}>
            <button type="submit" className={styles['primaryButton']} disabled={answering || answer.length === 0}>{t('continue')}</button>
          </div>
        </form>
      )}
      {failure === undefined ? null : <p className={styles['error']} role="alert">{failure}</p>}
      <div className={styles['rowActions']}>
        {busy
          ? <button type="button" className={styles['secondaryButton']} onClick={cancel}>{t('cancel')}</button>
          : <button type="button" className={styles['primaryButton']} disabled={!authorization.credential.writable || clearing}
            onClick={() => { void start() }}>{actionLabel}</button>}
        {authorization.credential.configured && !busy
          ? <button type="button" className={styles['dangerButton']} disabled={!authorization.credential.writable || clearing}
            onClick={() => { void signOut() }}>{t('signOut')}</button>
          : null}
      </div>
    </section>
  )
}
