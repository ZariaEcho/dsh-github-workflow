/**
 * `gh_merge_pr` — merge a pull request.
 *
 * Safety pre-checks before merging: the PR must exist, be open, and not a
 * draft; `deleteBranchAfter` additionally removes the head branch after a
 * successful merge (never the default branch — checked against the repo).
 * Mutating: gated by the permission choke point.
 *
 * @module dsh-github-workflow/tools/merge-pr
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDeps } from '../github-client.ts'
import { invalidateRepo } from '../utils/cache.ts'
import { TEXT_OUTPUT, kv } from '../utils/format.ts'
import { prepareMutation } from '../utils/permission.ts'
import { traceOperation } from '../utils/trace.ts'

/** Register the tool. */
export function registerMergePrTool(ctx: Context, deps: ToolDeps): void {
  ctx.tools.register(defineTool({
    name: 'gh_merge_pr',
    description:
      'Merge a pull request (merge / squash / rebase) via the GraphQL API — the REST merge endpoint returns 404 for OAuth tokens, so GraphQL is the reliable channel. Refuses non-open PRs; draft PRs are refused unless markReady is set (GraphQL markPullRequestReadyForReview — the REST draft:false PATCH is silently ignored by GitHub). Optionally deletes the head branch afterwards. Mutating: gated by approval, read-only mode, and token scopes.',
    parameters: {
      owner: { type: 'string', required: true, description: 'Repository owner (user or organization).' },
      repo: { type: 'string', required: true, description: 'Repository name.' },
      pullNumber: { type: 'integer', required: true, description: 'Pull request number to merge.' },
      mergeMethod: { type: 'string', enum: ['merge', 'squash', 'rebase'], description: 'Merge method. Defaults to squash.' },
      commitTitle: { type: 'string', description: 'Custom commit title for the merge.' },
      commitMessage: { type: 'string', description: 'Custom commit message for the merge.' },
      markReady: { type: 'boolean', description: 'Mark the draft PR ready for review (GraphQL) before merging. Defaults to false.' },
      deleteBranchAfter: { type: 'boolean', description: 'Delete the head branch after a successful merge (never the default branch). Defaults to false.' },
    },
    output: TEXT_OUTPUT,
    timeoutMs: deps.config.timeoutMs + 30_000,
    async execute(args, exec) {
      const action = `merge pull request #${args.pullNumber}`
      const prepared = await prepareMutation(deps, exec, action)
      if ('denied' in prepared) return prepared.denied
      const client = prepared.client

      const pr = await client.getPullRequest(args.owner, args.repo, args.pullNumber)
      if (pr.state !== 'open') {
        return `## Mutation blocked\n\nPR #${args.pullNumber} is ${pr.state}; only open pull requests can be merged.`
      }
      if (pr.draft && args.markReady !== true) {
        return '## Mutation blocked\n\nDraft pull requests cannot be merged — pass markReady: true to mark it ready for review first, or do it manually.'
      }

      const result = await mergeViaGraphql(client, args, pr.draft && args.markReady === true)

      let branchNote = ''
      if (args.deleteBranchAfter === true) {
        const repo = await client.getRepo(args.owner, args.repo)
        const headIsLocal = pr.head.repo?.full_name === `${args.owner}/${args.repo}`
        if (pr.head.ref === repo.default_branch || !headIsLocal) {
          branchNote = `\n\n> Head branch "${pr.head.ref}" was kept (default branch or fork head).`
        } else {
          try {
            await client.deleteBranch(args.owner, args.repo, pr.head.ref)
            branchNote = `\n\nHead branch "${pr.head.ref}" deleted.`
          } catch (error) {
            branchNote = `\n\n> Head branch "${pr.head.ref}" could not be deleted: ${error instanceof Error ? error.message : String(error)}`
          }
        }
      }

      invalidateRepo(args.owner, args.repo, deps.cacheNs)

      traceOperation(ctx, exec, {
        operation: 'merge_pr',
        outcome: 'success',
        owner: args.owner,
        repo: args.repo,
        number: args.pullNumber,
        url: pr.html_url,
        detail: `method: ${args.mergeMethod ?? 'squash'}, sha: ${result.sha.slice(0, 7)}${args.markReady === true ? ', marked ready' : ''}${args.deleteBranchAfter === true ? ', head branch deleted' : ''}`,
      })

      return [
        `# Pull request #${args.pullNumber} merged`,
        '',
        kv('sha', result.sha),
        kv('message', result.message || 'merged'),
        kv('url', pr.html_url),
        branchNote,
      ].filter(line => line.length > 0).join('\n')
    },
  }))
}

interface MergeArgs {
  readonly owner: string
  readonly repo: string
  readonly pullNumber: number
  readonly mergeMethod?: 'merge' | 'squash' | 'rebase'
  readonly commitTitle?: string
  readonly commitMessage?: string
}

interface MergeResult {
  readonly sha: string
  readonly message: string
}

const MERGE_PREP_QUERY = `
  query MergePrep($owner: String!, $repo: String!, $number: Int!) {
    repository(owner: $owner, name: $repo) {
      pullRequest(number: $number) { id }
    }
  }`

const MARK_READY_MUTATION = `
  mutation MarkReady($id: ID!) {
    markPullRequestReadyForReview(input: { pullRequestId: $id }) {
      pullRequest { isDraft }
    }
  }`

const MERGE_MUTATION = `
  mutation MergePr($id: ID!, $method: PullRequestMergeMethod!, $headline: String, $body: String) {
    mergePullRequest(input: {
      pullRequestId: $id
      mergeMethod: $method
      commitHeadline: $headline
      commitBody: $body
    }) {
      pullRequest {
        mergedAt
        mergeCommit { oid }
      }
    }
  }`

/**
 * Merge via GraphQL: `mergePullRequest` works where the REST endpoint
 * returns 404 (verified live with an OAuth token). Optionally marks the draft
 * PR ready first via `markPullRequestReadyForReview` — the REST
 * `draft: false` PATCH is silently ignored by the API.
 */
async function mergeViaGraphql(
  client: import('../github-client.ts').GitHubClient,
  args: MergeArgs,
  markReady: boolean,
): Promise<MergeResult> {
  const method = (args.mergeMethod ?? 'squash').toUpperCase()

  const prep = await client.graphql<{
    data?: { repository?: { pullRequest?: { id?: string } } }
    errors?: Array<{ message: string }>
  }>(MERGE_PREP_QUERY, { owner: args.owner, repo: args.repo, number: args.pullNumber })
  const errors = prep.errors ?? []
  if (errors.length > 0) throw new Error(errors.map(error => error.message).join('; '))
  const pullRequestId = prep.data?.repository?.pullRequest?.id
  if (pullRequestId === undefined) throw new Error('merge failed: pull request node id not found')

  if (markReady) {
    const ready = await client.graphql<{
      data?: { markPullRequestReadyForReview?: { pullRequest?: { isDraft?: boolean } } }
      errors?: Array<{ message: string }>
    }>(MARK_READY_MUTATION, { id: pullRequestId })
    const readyErrors = ready.errors ?? []
    if (readyErrors.length > 0) throw new Error(readyErrors.map(error => error.message).join('; '))
  }

  const variables: Record<string, unknown> = { id: pullRequestId, method, headline: null, body: null }
  if (args.commitTitle !== undefined) variables.headline = args.commitTitle
  if (args.commitMessage !== undefined) variables.body = args.commitMessage
  const result = await client.graphql<{
    data?: {
      mergePullRequest?: {
        pullRequest?: { mergedAt?: string | null; mergeCommit?: { oid?: string } | null }
      }
    }
    errors?: Array<{ message: string }>
  }>(MERGE_MUTATION, variables)
  const resultErrors = result.errors ?? []
  if (resultErrors.length > 0) throw new Error(resultErrors.map(error => error.message).join('; '))

  const mergedAt = result.data?.mergePullRequest?.pullRequest?.mergedAt
  const oid = result.data?.mergePullRequest?.pullRequest?.mergeCommit?.oid
  if (mergedAt === undefined || mergedAt === null) {
    throw new Error('merge failed: GitHub did not confirm the merge (no mergedAt)')
  }
  return { sha: oid ?? 'unknown', message: 'merged' }
}
