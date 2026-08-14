/**
 * `gh_request_reviewers` — request reviewers on a pull request (users and
 * optionally teams). Mutating: gated by the permission choke point.
 *
 * @module dsh-github-workflow/tools/request-reviewers
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDeps } from '../github-client.ts'
import { TEXT_OUTPUT, bullet, kv } from '../utils/format.ts'
import { prepareMutation } from '../utils/permission.ts'
import { traceOperation } from '../utils/trace.ts'

/** Register the tool. */
export function registerRequestReviewersTool(ctx: Context, deps: ToolDeps): void {
  ctx.tools.register(defineTool({
    name: 'gh_request_reviewers',
    description:
      'Request reviewers on a pull request: GitHub usernames (required) and optionally team slugs. Mutating: gated by approval, read-only mode, and token scopes.',
    parameters: {
      owner: { type: 'string', required: true, description: 'Repository owner (user or organization).' },
      repo: { type: 'string', required: true, description: 'Repository name.' },
      pullNumber: { type: 'integer', required: true, description: 'Pull request number.' },
      reviewers: { type: 'array', items: { type: 'string' }, required: true, description: 'GitHub usernames to request review from (at least one).' },
      teamReviewers: { type: 'array', items: { type: 'string' }, description: 'Optional team slugs to request review from.' },
    },
    output: TEXT_OUTPUT,
    timeoutMs: deps.config.timeoutMs + 20_000,
    async execute(args, exec) {
      if (args.reviewers.length === 0) {
        return '## Mutation blocked\n\n`reviewers` must contain at least one username.'
      }
      const action = `request reviewers on pull request #${args.pullNumber}`
      const prepared = await prepareMutation(deps, exec, action)
      if ('denied' in prepared) return prepared.denied
      const client = prepared.client

      const result = await client.requestReviewers(args.owner, args.repo, args.pullNumber, {
        reviewers: args.reviewers,
        ...(args.teamReviewers !== undefined && args.teamReviewers.length > 0
          ? { teamReviewers: args.teamReviewers }
          : {}),
      })

      const requested = result.reviewers.map(reviewer => reviewer.login)
      traceOperation(ctx, exec, {
        operation: 'request_reviewers',
        outcome: 'success',
        owner: args.owner,
        repo: args.repo,
        number: args.pullNumber,
        detail: `reviewers: ${requested.join(', ')}${args.teamReviewers !== undefined && args.teamReviewers.length > 0 ? `, teams: ${args.teamReviewers.join(', ')}` : ''}`,
      })

      return [
        `# Reviewers requested on PR #${args.pullNumber}`,
        '',
        kv('reviewers', requested.join(', ') || '–'),
        ...(args.teamReviewers !== undefined && args.teamReviewers.length > 0
          ? [kv('teams', args.teamReviewers.join(', '))]
          : []),
        '',
        bullet(requested.map(login => `@${login}`)),
      ].join('\n')
    },
  }))
}
