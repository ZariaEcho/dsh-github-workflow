/**
 * `gh_delete_branch` — delete a branch.
 *
 * Safety pre-checks: the branch must not be the repository default branch,
 * and must not be the head of any open pull request (in this repository).
 * Mutating: gated by the permission choke point.
 *
 * @module dsh-github-workflow/tools/delete-branch
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDeps } from '../github-client.ts'
import { invalidateRepo } from '../utils/cache.ts'
import { TEXT_OUTPUT, kv } from '../utils/format.ts'
import { prepareMutation } from '../utils/permission.ts'
import { traceOperation } from '../utils/trace.ts'

/** Register the tool. */
export function registerDeleteBranchTool(ctx: Context, deps: ToolDeps): void {
  ctx.tools.register(defineTool({
    name: 'gh_delete_branch',
    description:
      'Delete a branch. Refuses the repository default branch and branches with open pull requests. Mutating: gated by approval, read-only mode, and token scopes.',
    parameters: {
      owner: { type: 'string', required: true, description: 'Repository owner (user or organization).' },
      repo: { type: 'string', required: true, description: 'Repository name.' },
      branch: { type: 'string', required: true, description: 'Branch name to delete (e.g. feat/issue-42).' },
    },
    output: TEXT_OUTPUT,
    timeoutMs: deps.config.timeoutMs + 20_000,
    async execute(args, exec) {
      const action = `delete branch "${args.branch}"`
      const prepared = await prepareMutation(deps, exec, action)
      if ('denied' in prepared) return prepared.denied
      const client = prepared.client

      const repo = await client.getRepo(args.owner, args.repo)
      if (args.branch === repo.default_branch) {
        return '## Mutation blocked\n\nThe default branch cannot be deleted.'
      }

      const openPulls = await client.listPullRequests(args.owner, args.repo, 'open', 100)
      const blocking = openPulls.filter(pr =>
        pr.head.ref === args.branch && pr.head.repo?.full_name === `${args.owner}/${args.repo}`,
      )
      if (blocking.length > 0) {
        const numbers = blocking.map(pr => `#${pr.number}`).join(', ')
        return `## Mutation blocked\n\nBranch "${args.branch}" is the head of open pull request(s) ${numbers} — close or merge them first.`
      }

      await client.deleteBranch(args.owner, args.repo, args.branch)

      invalidateRepo(args.owner, args.repo, deps.cacheNs)

      traceOperation(ctx, exec, {
        operation: 'delete_branch',
        outcome: 'success',
        owner: args.owner,
        repo: args.repo,
        detail: `branch: ${args.branch}`,
      })

      return `# Branch "${args.branch}" deleted\n\n${kv('repo', `${args.owner}/${args.repo}`)}`
    },
  }))
}
