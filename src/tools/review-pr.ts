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
import { TEXT_OUTPUT, codeBlock, diffStat, firstLine, kv, relativeTime, section, table, truncate } from '../utils/format.ts'
import { prepareMutation } from '../utils/permission.ts'
import { traceOperation } from '../utils/trace.ts'

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
      const [diff, filePage, commentPage] = await Promise.all([
        client.getPullRequestDiff(args.owner, args.repo, args.pullNumber, exec.signal),
        client.listPullRequestFiles(args.owner, args.repo, args.pullNumber),
        client.listPullRequestReviewComments(args.owner, args.repo, args.pullNumber).catch(() => ({ items: [], truncated: false })),
      ])

      // Best-effort threaded view of the same comments via GraphQL (batch
      // query: threads with resolved state, path, line, and comment bodies).
      // Requires a token; tolerate failure and fall back to the REST list.
      let threads: ReviewThread[] | undefined
      if (client.authenticated) {
        try {
          threads = await fetchReviewThreads(client, args.owner, args.repo, args.pullNumber)
        } catch {
          threads = undefined
        }
      }

      return renderReviewAnalysis(
        args, pr, filePage.items, filePage.truncated, diff,
        commentPage.items, commentPage.truncated, threads, client.authenticated,
      )
    },
  }))
}

/** One GraphQL review thread. */
interface ReviewThread {
  readonly isResolved: boolean
  readonly path: string
  readonly line: number | null
  readonly comments: Array<{ login: string; body: string; createdAt: string }>
}

const REVIEW_THREADS_QUERY = `
  query ReviewThreads($owner: String!, $repo: String!, $number: Int!) {
    repository(owner: $owner, name: $repo) {
      pullRequest(number: $number) {
        reviewThreads(first: 20) {
          nodes {
            isResolved
            path
            line
            comments(first: 10) {
              nodes {
                author { login }
                body
                createdAt
              }
            }
          }
        }
      }
    }
  }`

/** Fetch review threads through one GraphQL call; throws on API errors. */
async function fetchReviewThreads(
  client: import('../github-client.ts').GitHubClient,
  owner: string,
  repo: string,
  pullNumber: number,
): Promise<ReviewThread[]> {
  const result = await client.graphql<{
    errors?: Array<{ message: string }>
    data?: {
      repository?: {
        pullRequest?: {
          reviewThreads?: { nodes?: Array<{
            isResolved: boolean
            path: string
            line: number | null
            comments?: { nodes?: Array<{
              author?: { login?: string } | null
              body?: string
              createdAt?: string
            }> }
          }> }
        }
      }
    }
  }>(REVIEW_THREADS_QUERY, { owner, repo, number: pullNumber })
  if (result.errors !== undefined && result.errors.length > 0) {
    throw new Error(result.errors.map(error => error.message).join('; '))
  }
  const nodes = result.data?.repository?.pullRequest?.reviewThreads?.nodes ?? []
  return nodes.map(node => ({
    isResolved: node.isResolved,
    path: node.path,
    line: node.line,
    comments: (node.comments?.nodes ?? []).map(comment => ({
      login: comment.author?.login ?? 'ghost',
      body: comment.body ?? '',
      createdAt: comment.createdAt ?? '',
    })),
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
  filesTruncated: boolean,
  diff: string,
  comments: Array<{
    id: number
    path: string
    line: number | null
    user: { login: string } | null
    body: string
    created_at: string
    in_reply_to_id: number | null
  }>,
  commentsTruncated: boolean,
  threads: ReviewThread[] | undefined,
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
    kv('mergeable state', pr.mergeable_state),
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
  lines.push('', section(`Files (${files.length}${filesTruncated ? '+ truncated' : ''})`, table(['File', 'Status', 'Δ'], rows)))

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

  if (comments.length > 0) {
    const rendered = comments.slice(0, 40).map(comment => {
      const location = comment.line !== null ? `${comment.path}:${comment.line}` : comment.path
      const reply = comment.in_reply_to_id !== null ? ` (reply to #${comment.in_reply_to_id})` : ''
      return `- #${comment.id} @${comment.user?.login ?? 'ghost'} (${relativeTime(comment.created_at)}) ${location}${reply}: ${firstLine(comment.body, 200)}`
    })
    lines.push('', section(`Existing review comments (${comments.length}${commentsTruncated ? '+ truncated' : ''})`, rendered.join('\n')))
  }

  if (threads !== undefined && threads.length > 0) {
    const rendered = threads.slice(0, 20).map(thread => {
      const location = thread.line !== null ? `${thread.path}:${thread.line}` : thread.path
      const state = thread.isResolved ? 'resolved' : 'open'
      const threadComments = thread.comments.slice(0, 5).map(comment =>
        `  - @${comment.login} (${relativeTime(comment.createdAt)}): ${firstLine(comment.body, 160)}`,
      ).join('\n')
      return `- [${state}] ${location}\n${threadComments}`
    })
    lines.push('', section('Review threads (threaded view, GraphQL)', rendered.join('\n')))
  }

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
        '- To answer an existing comment thread, call gh_reply_comment with its comment id and the pullNumber.',
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
