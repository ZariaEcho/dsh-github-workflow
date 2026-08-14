/**
 * dsh-github-workflow — GitHub deep-workflow toolset for DeepSeek Harness
 * agents.
 *
 * Turns GitHub from raw API calls into workflow-aware tools that cover the
 * full Issue → analyze → code → draft PR → CI → review → merge loop:
 *
 * - `gh_get_repo_context` — orient in a repository, including CODEOWNERS and
 *   branch protection (cached per repository).
 * - `gh_analyze_issue` — deep issue analysis (understanding, impact,
 *   implementation suggestions, risks) with related code, historical PRs, and
 *   similar issues.
 * - `gh_search_related` — find duplicates and prior work before implementing.
 * - `gh_create_draft_pr` — draft PRs with standardized, diff-grounded
 *   descriptions, optionally linked to an issue.
 * - `gh_check_ci_status` — combined status, check runs, and failing-run
 *   annotations for a ref or PR.
 * - `gh_review_pr` — severity-ranked review (blocker / suggestion / polish)
 *   with existing comment threads (GraphQL); can submit the review.
 * - `gh_request_reviewers` — request reviewers on a PR.
 * - `gh_reply_comment` — reply inside review or issue comment threads, with
 *   optional GraphQL thread resolution.
 * - `gh_generate_release_notes` — draft a changelog from merged PRs between
 *   two refs.
 * - `gh_merge_pr` — merge a PR (refuses drafts), optionally deleting the head
 *   branch.
 * - `gh_close_issue` — close an issue or PR with a state reason.
 * - `gh_delete_branch` — delete a branch (refuses default branch and branches
 *   with open PRs).
 *
 * Security: every mutating call funnels through a single choke point
 * (read-only mode, host approval, token scope verification), fail-closed, and
 * every key operation (success or denial) is traced to the session log.
 *
 * @module dsh-github-workflow
 */

import type { Context } from '@deepseek-ai/cordis'
import { resolveConfig, type Config } from './config.ts'
import { createToolDeps } from './github-client.ts'
import { registerAnalyzeIssueTool } from './tools/analyze-issue.ts'
import { registerCreateDraftPrTool } from './tools/create-draft-pr.ts'
import { registerReviewPrTool } from './tools/review-pr.ts'
import { registerGetRepoContextTool } from './tools/get-repo-context.ts'
import { registerSearchRelatedTool } from './tools/search-related.ts'
import { registerCheckCiStatusTool } from './tools/check-ci-status.ts'
import { registerMergePrTool } from './tools/merge-pr.ts'
import { registerCloseIssueTool } from './tools/close-issue.ts'
import { registerDeleteBranchTool } from './tools/delete-branch.ts'
import { registerRequestReviewersTool } from './tools/request-reviewers.ts'
import { registerReplyCommentTool } from './tools/reply-comment.ts'
import { registerReleaseNotesTool } from './tools/release-notes.ts'
import { initRepoFactsCache } from './utils/cache.ts'

export { Config } from './config.ts'
export type { Config as ConfigSchema } from './config.ts'

/** Cordis plugin name used by Loader diagnostics. */
export const name = 'github-workflow'

/** Capability services required by this plugin. */
export const inject = ['tools', 'systemPrompt']

const PROMPT_TEXT =
  'The gh_* tools (github-workflow) cover the full GitHub Issue → code → PR → review → merge loop. '
  + 'gh_get_repo_context orients in a repository (including CODEOWNERS and branch protection); '
  + 'gh_analyze_issue digs into one issue (problem understanding, impact scope, implementation suggestions, '
  + 'potential risks) and pulls related code, historical PRs, and similar issues; '
  + 'gh_search_related finds duplicates or prior work before implementing. '
  + 'After implementing, gh_create_draft_pr creates a draft PR with a standardized description derived from the '
  + 'linked issue or the actual diff; gh_check_ci_status watches its checks (with failing-run annotations); '
  + 'gh_review_pr produces a severity-ranked review (blocker/suggestion/polish), shows existing comment threads, '
  + 'and with post: true submits it to GitHub; gh_reply_comment answers review or issue threads; '
  + 'gh_request_reviewers asks specific people to review. To finish: gh_merge_pr merges (never drafts; can delete '
  + 'the head branch), gh_close_issue closes tracked issues, gh_delete_branch cleans up branches. '
  + 'Mutating calls ask the user for approval by default and fail in read-only mode; every key operation is '
  + 'recorded in the session log. Never put the token in tool arguments, file contents, or commit messages.'

/** Register every tool and the shared model guidance. */
export function apply(ctx: Context, config: Config): void {
  const resolved = resolveConfig(config)
  const deps = createToolDeps(ctx, resolved)
  initRepoFactsCache(resolved.contextCachePath, deps.cacheNs)

  ctx.systemPrompt.section({
    name: 'tool:github-workflow',
    order: 115,
    text: PROMPT_TEXT,
  })

  registerAnalyzeIssueTool(ctx, deps)
  registerCreateDraftPrTool(ctx, deps)
  registerReviewPrTool(ctx, deps)
  registerGetRepoContextTool(ctx, deps)
  registerSearchRelatedTool(ctx, deps)
  registerCheckCiStatusTool(ctx, deps)
  registerMergePrTool(ctx, deps)
  registerCloseIssueTool(ctx, deps)
  registerDeleteBranchTool(ctx, deps)
  registerRequestReviewersTool(ctx, deps)
  registerReplyCommentTool(ctx, deps)
  registerReleaseNotesTool(ctx, deps)
}
