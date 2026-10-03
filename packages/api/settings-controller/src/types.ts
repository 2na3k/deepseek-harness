/**
 * Browser-safe remote views and failure vocabulary for the configuration
 * surfaces this package serves. Redacted settings views live with their seam in
 * `@deepseek-ai/dsh-settings/types`, whose Cordis event declarations already
 * register that file for the Client compilation face.
 *
 * @module @deepseek-ai/dsh-api-settings-controller/types
 */

import type { AuthorizationEntry, AuthorizationNotice, AuthorizationOutcome, AuthorizationPrompt } from '@deepseek-ai/dsh-authorization/types'
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { CredentialRecord } from '@deepseek-ai/dsh-credentials/types'

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /**
     * Every seam refusal that is not a stale write: an unregistered or malformed
     * namespace, a read-only provider, schema validation, storage.
     */
    'settings/rejected': { readonly ns: string }
    /**
     * The stored revision moved after the caller read it. Its own outcome rather
     * than an invalid request: the caller must re-read and re-apply.
     */
    'settings/conflict': { readonly ns: string; readonly expected: number; readonly actual: number }
    /**
     * The provider refused a valid credential write, for example because a
     * read-only source shadows the reference. The details name only the
     * reference, never the value.
     */
    'credential/rejected': { readonly ref: string }
  }
}

/** Opaque identifier for one Host authorization attempt. */
export type AuthorizationAttemptId = Branded<'AuthorizationAttemptId'>
/** Opaque identifier for one host-side authorization prompt. */
export type AuthorizationPromptId = Branded<'AuthorizationPromptId'>

/** Safe credential facts paired with one available authorization flow. */
export interface AuthorizationProviderView extends AuthorizationEntry {
  /** Presence, record kind, and writability; credential contents never cross the Remote. */
  readonly credential: {
    readonly configured: boolean
    readonly kind?: CredentialRecord['kind']
    readonly writable: boolean
  }
}

/** Authorization prompt with its process-local cancellation signal removed. */
export type AuthorizationPromptView = AuthorizationPrompt extends infer Prompt
  ? Prompt extends { signal?: AbortSignal } ? Omit<Prompt, 'signal'> : never
  : never

/** One Client-visible frame from a human-guided authorization attempt. */
export type AuthorizationFrame =
  | { readonly type: 'started'; readonly attemptId: AuthorizationAttemptId }
  | { readonly type: 'notice'; readonly notice: AuthorizationNotice }
  | {
    readonly type: 'prompt'
    readonly attemptId: AuthorizationAttemptId
    readonly promptId: AuthorizationPromptId
    readonly prompt: AuthorizationPromptView
  }
  | { readonly type: 'prompt-withdrawn'; readonly attemptId: AuthorizationAttemptId; readonly promptId: AuthorizationPromptId }
  | { readonly type: 'settled'; readonly outcome: AuthorizationOutcome | { readonly status: 'failed'; readonly message: string } }

/** Confirmation that the settings document was handed to the native editor. */
export interface SettingsDocumentOpenValue {
  readonly opened: true
}
