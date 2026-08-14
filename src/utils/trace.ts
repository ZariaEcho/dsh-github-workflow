/**
 * Session-log traceability.
 *
 * Every key operation of the toolset appends a structured, JSON-serializable
 * event to the owning session's append-only log, so the full workflow — PR
 * created, review submitted, mutation denied with its reason — is traceable
 * from the session history alone, independent of the model-facing tool
 * results. The event type is plugin-merged into the session event vocabulary.
 *
 * Appends are best-effort: without a sessions service or agent context the
 * trace is skipped, and a failing append is logged without breaking the
 * operation.
 *
 * @module dsh-github-workflow/utils/trace
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session/types'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'

/** One traced key operation. */
export interface GitHubWorkflowOperationEvent {
  /** Operation identifier, e.g. `create_draft_pr`, `submit_review`. */
  operation: string
  /** `success` — the operation happened; `denied` — a gate refused it. */
  outcome: 'success' | 'denied'
  /** Repository owner, when known at the trace site. */
  owner?: string
  /** Repository name, when known at the trace site. */
  repo?: string
  /** Issue / pull request number, when applicable. */
  number?: number
  /** Result URL (pull request, review), when applicable. */
  url?: string
  /** Short human-readable detail (branch pair, denial reason). */
  detail?: string
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * One key github-workflow operation settled in this session: a mutation
     * succeeded or a mutation gate refused it (read-only mode, approval,
     * token scopes). Log-only: `deriveMessages()` ignores it; UIs and audit
     * folds read it for traceability.
     */
    'github-workflow/operation': GitHubWorkflowOperationEvent
  }
}

/**
 * Append one trace event to the calling agent's session log. Never throws:
 * the operation it documents must not fail because the trace failed.
 */
export function traceOperation(
  ctx: Context,
  exec: ToolRunContext,
  payload: GitHubWorkflowOperationEvent,
): void {
  const sessions = ctx.get('sessions')
  const agent = exec.agent
  if (sessions === undefined || agent === undefined) return
  const session = sessions.get(agent.id)
  if (session === undefined) return
  try {
    session.append('github-workflow/operation', payload)
  } catch (error) {
    ctx.logger.warn('github-workflow: session trace append failed: %s', String(error))
  }
}
