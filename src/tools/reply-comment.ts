/**
 * `gh_reply_comment` — reply inside an existing comment thread, closing the
 * review loop: see comments via `gh_review_pr`, answer with this tool.
 *
 * Two thread kinds, inferred from the id parameter given:
 * - `pullNumber` — reply inside a review-comment thread on a pull request.
 * - `issueNumber` — reply inside an issue-comment thread.
 * Exactly one of the two is required.
 *
 * Mutating: gated by the permission choke point.
 *
 * @module dsh-github-workflow/tools/reply-comment
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDeps } from '../github-client.ts'
import { TEXT_OUTPUT, kv } from '../utils/format.ts'
import { prepareMutation } from '../utils/permission.ts'
import { traceOperation } from '../utils/trace.ts'

/** Register the tool. */
export function registerReplyCommentTool(ctx: Context, deps: ToolDeps): void {
  ctx.tools.register(defineTool({
    name: 'gh_reply_comment',
    description:
      'Reply inside an existing comment thread. Pass pullNumber to reply to a review comment on a pull request, or issueNumber to reply to an issue comment — exactly one of the two. Mutating: gated by approval, read-only mode, and token scopes.',
    parameters: {
      owner: { type: 'string', required: true, description: 'Repository owner (user or organization).' },
      repo: { type: 'string', required: true, description: 'Repository name.' },
      commentId: { type: 'integer', required: true, description: 'The comment id to reply to (shown by gh_review_pr / gh_analyze_issue).' },
      body: { type: 'string', required: true, description: 'Reply text.' },
      pullNumber: { type: 'integer', description: 'Required for review-comment threads: the pull request number.' },
      issueNumber: { type: 'integer', description: 'Required for issue-comment threads: the issue number.' },
      resolveThread: { type: 'boolean', description: 'After replying, resolve the review thread containing the comment (GraphQL; review threads only). Defaults to false.' },
    },
    output: TEXT_OUTPUT,
    timeoutMs: deps.config.timeoutMs + 30_000,
    async execute(args, exec) {
      const hasPull = args.pullNumber !== undefined
      const hasIssue = args.issueNumber !== undefined
      if (hasPull === hasIssue) {
        return '## Mutation blocked\n\nPass exactly one of `pullNumber` (review comment) or `issueNumber` (issue comment).'
      }

      const action = hasPull
        ? `reply to review comment #${args.commentId} on pull request #${args.pullNumber}`
        : `reply to comment #${args.commentId} on issue #${args.issueNumber}`
      const prepared = await prepareMutation(deps, exec, action)
      if ('denied' in prepared) return prepared.denied
      const client = prepared.client

      if (hasPull) {
        const reply = await client.replyToReviewComment(
          args.owner, args.repo, args.pullNumber as number, args.commentId, args.body,
        )
        let resolveNote: string | undefined
        if (args.resolveThread === true) {
          resolveNote = await resolveReviewThread(client, args.owner, args.repo, args.pullNumber as number, args.commentId)
        }
        traceOperation(ctx, exec, {
          operation: 'reply_comment',
          outcome: 'success',
          owner: args.owner,
          repo: args.repo,
          number: args.pullNumber as number,
          url: reply.html_url,
          detail: `in_reply_to review comment #${args.commentId}${resolveNote !== undefined ? `, ${resolveNote}` : ''}`,
        })
        return [
          `# Reply posted on PR #${args.pullNumber}`,
          '',
          kv('url', reply.html_url),
          kv('in reply to', `review comment #${args.commentId}`),
          kv('body', args.body),
          ...(resolveNote !== undefined ? ['', resolveNote] : []),
        ].join('\n')
      }

      if (args.resolveThread === true) {
        return '## Mutation blocked\n\nresolveThread only applies to review-comment threads (pass pullNumber).'
      }

      const reply = await client.replyToIssueComment(
        args.owner, args.repo, args.issueNumber as number, args.commentId, args.body,
      )
      traceOperation(ctx, exec, {
        operation: 'reply_comment',
        outcome: 'success',
        owner: args.owner,
        repo: args.repo,
        number: args.issueNumber as number,
        url: reply.html_url,
        detail: `in_reply_to issue comment #${args.commentId}`,
      })
      return [
        `# Reply posted on issue #${args.issueNumber}`,
        '',
        kv('url', reply.html_url),
        kv('in reply to', `issue comment #${args.commentId}`),
        kv('body', args.body),
      ].join('\n')
    },
  }))
}

/** GraphQL prep: locate the thread node containing the replied comment. */
interface ResolvePrep {
  data?: {
    repository?: {
      pullRequest?: {
        reviewThreads?: { nodes?: Array<{
          id?: string
          comments?: { nodes?: Array<{ databaseId?: number }> }
        }> }
      }
    }
  }
}

const RESOLVE_PREP_QUERY = `
  query ResolvePrep($owner: String!, $repo: String!, $number: Int!) {
    repository(owner: $owner, name: $repo) {
      pullRequest(number: $number) {
        reviewThreads(first: 50) {
          nodes {
            id
            comments(first: 100) { nodes { databaseId } }
          }
        }
      }
    }
  }`

const RESOLVE_MUTATION = `
  mutation ResolveThread($threadId: ID!) {
    resolveReviewThread(input: { threadId: $threadId }) {
      thread { id isResolved }
    }
  }`

/**
 * Resolve the review thread containing `commentId`. Best-effort: any failure
 * returns a note for the output instead of failing the reply.
 */
async function resolveReviewThread(
  client: import('../github-client.ts').GitHubClient,
  owner: string,
  repo: string,
  pullNumber: number,
  commentId: number,
): Promise<string> {
  try {
    const prep = await client.graphql<ResolvePrep & { errors?: Array<{ message: string }> }>(
      RESOLVE_PREP_QUERY,
      { owner, repo, number: pullNumber },
    )
    if (prep.errors !== undefined && prep.errors.length > 0) {
      return `thread resolution failed: ${prep.errors.map(error => error.message).join('; ')}`
    }
    const thread = (prep.data?.repository?.pullRequest?.reviewThreads?.nodes ?? []).find(node =>
      (node.comments?.nodes ?? []).some(comment => comment.databaseId === commentId),
    )
    if (thread?.id === undefined) {
      return 'thread containing the comment was not found; not resolved'
    }
    const result = await client.graphql<{
      data?: { resolveReviewThread?: { thread?: { isResolved?: boolean } } }
      errors?: Array<{ message: string }>
    }>(RESOLVE_MUTATION, { threadId: thread.id })
    if (result.errors !== undefined && result.errors.length > 0) {
      return `thread resolution failed: ${result.errors.map(error => error.message).join('; ')}`
    }
    if (result.data?.resolveReviewThread?.thread?.isResolved === true) {
      return 'review thread resolved'
    }
    return 'thread resolution returned an unexpected result'
  } catch (error) {
    return `thread resolution failed: ${error instanceof Error ? error.message : String(error)}`
  }
}
