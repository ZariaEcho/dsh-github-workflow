/**
 * dsh-github-workflow — GitHub deep-workflow toolset for DeepSeek Harness
 * agents.
 *
 * Turns GitHub from raw API calls into workflow-aware tools that cover the
 * Issue → analyze → code → draft PR → CI → review loop:
 *
 * - `gh_get_repo_context` — orient in an unfamiliar repository.
 * - `gh_analyze_issue` — deep issue analysis (understanding, impact,
 *   implementation suggestions, risks).
 * - `gh_search_related` — find duplicates and prior work before implementing.
 * - `gh_create_draft_pr` — draft PRs with standardized, diff-grounded
 *   descriptions, optionally linked to an issue.
 * - `gh_check_ci_status` — combined status and check runs for a ref or PR.
 * - `gh_review_pr` — severity-ranked structured review; can submit the
 *   review comment to GitHub.
 *
 * Security: every mutating call funnels through a single choke point
 * (read-only mode, host approval, token scope verification), fail-closed.
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

export { Config } from './config.ts'
export type { Config as ConfigSchema } from './config.ts'

/** Cordis plugin name used by Loader diagnostics. */
export const name = 'github-workflow'

/** Capability services required by this plugin. */
export const inject = ['tools', 'systemPrompt']

const PROMPT_TEXT =
  'The gh_* tools (github-workflow) cover the GitHub Issue → code → PR → review loop. '
  + 'gh_get_repo_context orients in an unfamiliar repository; gh_analyze_issue digs into one issue '
  + '(problem understanding, impact scope, implementation suggestions, potential risks); '
  + 'gh_search_related finds duplicates or prior work before implementing. '
  + 'After implementing, gh_create_draft_pr creates a draft PR with a standardized description '
  + 'derived from the linked issue or the actual diff; gh_check_ci_status watches its checks; '
  + 'gh_review_pr produces a severity-ranked review, and with post: true submits it to GitHub. '
  + 'Mutating calls ask the user for approval by default and fail in read-only mode. '
  + 'Never put the token in tool arguments, file contents, or commit messages.'

/** Register every tool and the shared model guidance. */
export function apply(ctx: Context, config: Config): void {
  const resolved = resolveConfig(config)
  const deps = createToolDeps(ctx, resolved)

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
}
