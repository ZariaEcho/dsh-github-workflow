/**
 * `gh_close_issue` — close an issue (or a pull request) with an optional
 * state reason. Mutating: gated by the permission choke point.
 *
 * @module dsh-github-workflow/tools/close-issue
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDeps } from '../github-client.ts'
import { invalidateRepo } from '../utils/cache.ts'
import { TEXT_OUTPUT, kv } from '../utils/format.ts'
import { prepareMutation } from '../utils/permission.ts'
import { traceOperation } from '../utils/trace.ts'

/** Register the tool. */
export function registerCloseIssueTool(ctx: Context, deps: ToolDeps): void {
  ctx.tools.register(defineTool({
    name: 'gh_close_issue',
    description:
      'Close a GitHub issue (or pull request) with an optional state reason (completed / not planned). Mutating: gated by approval, read-only mode, and token scopes.',
    parameters: {
      owner: { type: 'string', required: true, description: 'Repository owner (user or organization).' },
      repo: { type: 'string', required: true, description: 'Repository name.' },
      issueNumber: { type: 'integer', required: true, description: 'Issue (or pull request) number to close.' },
      stateReason: { type: 'string', enum: ['completed', 'not_planned'], description: 'Optional state reason recorded by GitHub.' },
    },
    output: TEXT_OUTPUT,
    timeoutMs: deps.config.timeoutMs + 20_000,
    async execute(args, exec) {
      const action = `close issue #${args.issueNumber}`
      const prepared = await prepareMutation(deps, exec, action)
      if ('denied' in prepared) return prepared.denied
      const client = prepared.client

      const issue = await client.closeIssue(args.owner, args.repo, args.issueNumber, args.stateReason)

      invalidateRepo(args.owner, args.repo, deps.cacheNs)

      traceOperation(ctx, exec, {
        operation: 'close_issue',
        outcome: 'success',
        owner: args.owner,
        repo: args.repo,
        number: args.issueNumber,
        url: issue.html_url,
        ...(args.stateReason !== undefined ? { detail: `state_reason: ${args.stateReason}` } : {}),
      })

      return [
        `# Issue #${args.issueNumber} closed`,
        '',
        kv('title', issue.title),
        kv('state', issue.state),
        ...(args.stateReason !== undefined ? [kv('state reason', args.stateReason)] : []),
        kv('url', issue.html_url),
      ].join('\n')
    },
  }))
}
