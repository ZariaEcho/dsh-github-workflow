/**
 * `gh_review_pr` — structured review of one pull request.
 *
 * Two-phase design:
 * - `post: false` (default): read-only analysis — PR metadata, files, the
 *   diff, and a severity-ranked review scaffold (critical / major / minor /
 *   nit) the agent completes.
 * - `post: true`: submit the agent-authored review comment to GitHub
 *   (`COMMENT` / `APPROVE` / `REQUEST_CHANGES`). Mutating: gated by the
 *   permission choke point.
 *
 * @module dsh-github-workflow/tools/review-pr
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { GitHubPullRequest, GitHubPullRequestFile, ToolDeps } from '../github-client.ts'
import { codeBlock, diffStat, kv, relativeTime, section, table, truncate } from '../utils/format.ts'
import { prepareMutation } from '../utils/permission.ts'
import { traceOperation } from '../utils/trace.ts'

const TEXT_OUTPUT = {
  schema: { type: 'string' as const },
  render: (_args: unknown, value: string) => [{ type: 'text' as const, text: value }],
}

const DIFF_MAX_CHARS = 48_000

/** Register the tool. */
export function registerReviewPrTool(ctx: Context, deps: ToolDeps): void {
  ctx.tools.register(defineTool({
    name: 'gh_review_pr',
    description:
      'Structured review of a pull request: metadata, files, diff, and a severity-ranked review scaffold (blocker 阻断 / suggestion 建议 / polish 优化). With post: true, submits an agent-authored review comment (COMMENT, APPROVE, or REQUEST_CHANGES) — mutating, gated by approval, read-only mode, and token scopes.',
    parameters: {
      owner: { type: 'string', required: true, description: 'Repository owner (user or organization).' },
      repo: { type: 'string', required: true, description: 'Repository name.' },
      pullNumber: { type: 'integer', required: true, description: 'Pull request number.' },
      focus: { type: 'string', description: 'Comma-separated filename substrings to focus the diff on (e.g. "src/core,index.ts").' },
      post: { type: 'boolean', description: 'Submit the review comment instead of analyzing. Defaults to false.' },
      body: { type: 'string', description: 'Review comment body. Required when post is true.' },
      event: { type: 'string', enum: ['COMMENT', 'APPROVE', 'REQUEST_CHANGES'], description: 'Review event when posting. Defaults to COMMENT.' },
    },
    output: TEXT_OUTPUT,
    timeoutMs: deps.config.timeoutMs + 30_000,
    isConcurrencySafe: args => args.post !== true,
    async execute(args, exec) {
      if (args.post === true) {
        if (args.body === undefined || args.body.trim().length === 0) {
          return '## Mutation blocked\n\npost: true requires a non-empty `body` with the review comment.'
        }
        const prepared = await prepareMutation(deps, exec, 'submit pull request review')
        if ('denied' in prepared) return prepared.denied
        const client = prepared.client
        const review = await client.submitPullRequestReview(args.owner, args.repo, args.pullNumber, {
          body: args.body,
          event: args.event ?? 'COMMENT',
        })
        traceOperation(ctx, exec, {
          operation: 'submit_review',
          outcome: 'success',
          owner: args.owner,
          repo: args.repo,
          number: args.pullNumber,
          url: review.html_url,
          detail: `event: ${review.state}`,
        })
        return [
          `# Review submitted on PR #${args.pullNumber}`,
          '',
          kv('event', review.state),
          kv('url', review.html_url),
          kv('submitted', relativeTime(review.submitted_at)),
        ].join('\n')
      }

      const client = await deps.client()
      const pr = await client.getPullRequest(args.owner, args.repo, args.pullNumber)
      const [diff, files] = await Promise.all([
        client.getPullRequestDiff(args.owner, args.repo, args.pullNumber, exec.signal),
        client.listPullRequestFiles(args.owner, args.repo, args.pullNumber),
      ])
      return renderReviewAnalysis(args, pr, files, diff, client.authenticated)
    },
  }))
}

interface RenderArgs {
  readonly owner: string
  readonly repo: string
  readonly pullNumber: number
  readonly focus?: string
}

function renderReviewAnalysis(
  args: RenderArgs,
  pr: GitHubPullRequest,
  files: GitHubPullRequestFile[],
  diff: string,
  authenticated: boolean,
): string {
  const merged = pr.merged_at !== null ? ' (merged)' : ''
  const lines: string[] = [
    `# PR #${pr.number} — ${pr.title}`,
    '',
    kv('repo', `${args.owner}/${args.repo}`),
    kv('state', `${pr.state}${merged}${pr.draft ? ' (draft)' : ''}`),
    kv('author', pr.user?.login ?? '–'),
    kv('branch', `${pr.head.ref} → ${pr.base.ref}`),
    kv('changed', `${pr.changed_files} files, ${diffStat(pr.additions, pr.deletions)}`),
    kv('mergeable', pr.mergeable === null ? 'unknown' : String(pr.mergeable)),
    kv('updated', relativeTime(pr.updated_at)),
    kv('auth', authenticated ? 'authenticated' : 'anonymous (60 req/h rate limit)'),
  ]

  if (pr.body !== null && pr.body.trim().length > 0) {
    lines.push('', section('PR description', truncate(pr.body, 1500)))
  }

  const focusPatterns = (args.focus ?? '')
    .split(',')
    .map(part => part.trim())
    .filter(part => part.length > 0)
  const visibleFiles = focusPatterns.length > 0
    ? files.filter(file => focusPatterns.some(pattern => file.filename.includes(pattern)))
    : files

  const rows = files.slice(0, 60).map(file => [
    `\`${file.filename}\``,
    file.status,
    diffStat(file.additions, file.deletions),
  ])
  lines.push('', section(`Files (${files.length})`, table(['File', 'Status', 'Δ'], rows)))

  if (focusPatterns.length > 0) {
    lines.push(
      '',
      `## Focused diff (${visibleFiles.length} of ${files.length} files match "${focusPatterns.join(', ')}")`,
    )
  } else {
    lines.push('', '## Diff')
  }

  let visibleDiff = diff
  if (focusPatterns.length > 0) {
    visibleDiff = filterDiffByFiles(diff, focusPatterns)
  }
  lines.push('', codeBlock('diff', truncate(visibleDiff, DIFF_MAX_CHARS)))

  lines.push(
    '',
    section(
      'Review scaffold — complete every section; rank findings by severity',
      [
        '### Blocker (阻断 — must fix before merge)',
        '- Correctness bugs, data loss, security issues, breaking behavior.',
        '',
        '### Suggestion (建议 — should improve before merge)',
        '- Edge cases, regressions, missing tests, naming, error messages.',
        '',
        '### Polish (优化 — nice to have)',
        '- Style, formatting, comments, minor refactors.',
        '',
        '### General',
        '- Overall assessment and whether the change achieves its intent.',
        '- To submit this review, call gh_review_pr again with post: true and this comment as `body`.',
      ].join('\n'),
    ),
  )

  return lines.join('\n')
}

/** Keep only hunks touching files matching any focus pattern (line-based). */
function filterDiffByFiles(diff: string, focusPatterns: readonly string[]): string {
  const hunks: string[] = []
  let current: string[] = []
  let keep = false
  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git')) {
      if (keep && current.length > 0) hunks.push(current.join('\n'))
      current = [line]
      keep = focusPatterns.some(pattern => line.includes(pattern))
    } else {
      current.push(line)
    }
  }
  if (keep && current.length > 0) hunks.push(current.join('\n'))
  const filtered = hunks.join('\n')
  return filtered.length > 0 ? filtered : `(no hunks matched ${focusPatterns.join(', ')})`
}
