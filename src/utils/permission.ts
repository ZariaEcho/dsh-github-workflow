/**
 * The single mutation choke point for the toolset.
 *
 * Every mutating tool (`gh_create_draft_pr`, `gh_review_pr` with
 * `post: true`) funnels through {@link assertMutationAllowed} before touching
 * the GitHub API. The guard enforces, in order:
 *
 * 1. **Read-only mode** — configured `readOnly: true` refuses every mutation.
 * 2. **Approval gate** — with `requireApprovalForMutations` (default `true`)
 *    the host approval service asks the user through the session's approval
 *    policy; any outcome other than `allowed-once` refuses the mutation.
 *    Missing approval service or agent context fails closed.
 * 3. **Token scopes** — configured `requiredTokenScopes` are verified against
 *    the token before the mutation is sent (fail-closed for unverifiable
 *    fine-grained tokens).
 *
 * Future mutating tools (merge PR, close issue, delete branch) must route
 * through this same function so the security surface stays one place.
 *
 * @module dsh-github-workflow/utils/permission
 */

import type {} from '@deepseek-ai/dsh-user-approval'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { GitHubError, type GitHubClient, type ToolDeps } from '../github-client.ts'
import { traceOperation } from './trace.ts'

/** Outcome of one mutation guard check. */
export type MutationVerdict =
  | { kind: 'allowed' }
  | { kind: 'denied'; reason: string }

/**
 * Check every mutation gate for one call. Throws nothing: every refusal is a
 * structured verdict the tool renders into its output.
 */
export async function assertMutationAllowed(
  deps: ToolDeps,
  exec: ToolRunContext,
  action: string,
): Promise<MutationVerdict> {
  if (deps.config.readOnly) {
    return { kind: 'denied', reason: `read-only mode is enabled: ${action} is not allowed` }
  }
  if (deps.config.requireApprovalForMutations) {
    const approval = deps.ctx.get('approval')
    if (approval === undefined) {
      return {
        kind: 'denied',
        reason: `approval gate: no approval service is composed in this runtime, so ${action} fails closed (set requireApprovalForMutations: false to disable the gate)`,
      }
    }
    const agent = exec.agent
    if (agent === undefined) {
      return { kind: 'denied', reason: `approval gate: no agent context for this call, so ${action} fails closed` }
    }
    let outcome: string
    try {
      outcome = await approval.request({
        agent,
        toolName: exec.name,
        callId: exec.callId,
        reason: `github-workflow: ${action}`,
        signal: exec.signal,
      })
    } catch (error) {
      return { kind: 'denied', reason: `approval gate: ${action} was refused (${String(error)})` }
    }
    if (outcome !== 'allowed-once') {
      return { kind: 'denied', reason: `approval gate: ${action} was not approved (outcome: ${outcome})` }
    }
  }
  return { kind: 'allowed' }
}

/**
 * Require an authenticated client and verify the configured token scopes.
 * @throws {@link GitHubError} when unauthenticated or scopes are
 * missing/unverifiable.
 */
export async function assertMutationCredentials(
  deps: ToolDeps,
  client: GitHubClient,
): Promise<void> {
  if (!client.authenticated) {
    throw new GitHubError(
      401,
      'POST',
      'github',
      `no GitHub token found (looked up "${deps.config.apiTokenEnv}" through the credentials seam): mutating operations require a token`,
      undefined,
    )
  }
  await client.assertTokenScopes(deps.config.requiredTokenScopes)
}

/** Error message formatter used by tool bodies. */
export function mutationDeniedText(verdict: MutationVerdict, action: string): string {
  if (verdict.kind === 'allowed') return ''
  return `## Mutation blocked\n\n${action} was not performed.\n\nReason: ${verdict.reason}`
}

/**
 * The one call every mutating tool makes: run the approval gate, build a
 * fresh client, and verify credentials (token presence + configured scopes).
 * Returns either the ready client or the denial text to render. Every denial
 * is traced to the session log at the choke point, so refused operations are
 * audit-visible even though nothing changed on GitHub.
 */
export async function prepareMutation(
  deps: ToolDeps,
  exec: ToolRunContext,
  action: string,
): Promise<{ client: GitHubClient } | { denied: string }> {
  const verdict = await assertMutationAllowed(deps, exec, action)
  if (verdict.kind === 'denied') {
    traceOperation(deps.ctx, exec, { operation: action, outcome: 'denied', detail: verdict.reason })
    return { denied: mutationDeniedText(verdict, action) }
  }
  let client: GitHubClient
  try {
    client = await deps.client()
    await assertMutationCredentials(deps, client)
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    traceOperation(deps.ctx, exec, { operation: action, outcome: 'denied', detail: reason })
    return { denied: `## Mutation blocked\n\n${action} was not performed.\n\nReason: ${reason}` }
  }
  return { client }
}
