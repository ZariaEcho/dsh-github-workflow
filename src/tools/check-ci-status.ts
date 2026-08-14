/**
 * `gh_check_ci_status` — one-call CI picture for a branch, commit, or pull
 * request: combined status plus the full check-run list. Read-only.
 *
 * @module dsh-github-workflow/tools/check-ci-status
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { GitHubCheckRun, ToolDeps } from '../github-client.ts'
import { kv, section, table } from '../utils/format.ts'

const TEXT_OUTPUT = {
  schema: { type: 'string' as const },
  render: (_args: unknown, value: string) => [{ type: 'text' as const, text: value }],
}

/** Register the tool. */
export function registerCheckCiStatusTool(ctx: Context, deps: ToolDeps): void {
  ctx.tools.register(defineTool({
    name: 'gh_check_ci_status',
    description:
      'Check CI status for one ref: the combined commit status plus every check run (name, status, conclusion, details URL). Pass exactly one of ref or pullNumber. Read-only.',
    parameters: {
      owner: { type: 'string', required: true, description: 'Repository owner (user or organization).' },
      repo: { type: 'string', required: true, description: 'Repository name.' },
      ref: { type: 'string', description: 'Branch name or commit SHA to check.' },
      pullNumber: { type: 'integer', description: 'Pull request number to check (its head commit is used).' },
    },
    output: TEXT_OUTPUT,
    timeoutMs: deps.config.timeoutMs + 20_000,
    isConcurrencySafe: () => true,
    async execute(args, _exec) {
      const hasRef = args.ref !== undefined && args.ref.length > 0
      if (!hasRef && args.pullNumber === undefined) {
        return '## Invalid arguments\n\nProvide exactly one of `ref` or `pullNumber`.'
      }
      const client = await deps.client()

      let ref = args.ref
      if (args.pullNumber !== undefined) {
        const pr = await client.getPullRequest(args.owner, args.repo, args.pullNumber)
        ref = pr.head.sha
      }
      const [status, checks] = await Promise.all([
        client.getCombinedStatus(args.owner, args.repo, ref ?? '').catch(() => undefined),
        client.listCheckRuns(args.owner, args.repo, ref ?? '').catch(() => undefined),
      ])

      const lines: string[] = [
        `# CI status — ${args.owner}/${args.repo}`,
        '',
        kv('ref', ref ?? ''),
        kv('auth', client.authenticated ? 'authenticated' : 'anonymous'),
      ]

      const allChecks: GitHubCheckRun[] = [
        ...(status?.statuses ?? []).map(item => ({
          name: item.context,
          status: (item.state === 'pending' ? 'in_progress' : 'completed') as GitHubCheckRun['status'],
          conclusion: item.state,
          details_url: item.target_url ?? '–',
          started_at: null,
          completed_at: null,
        })),
        ...(checks?.check_runs ?? []),
      ]

      if (status !== undefined) {
        lines.push('', kv('combined status', status.state))
      }
      if (checks !== undefined) {
        lines.push('', kv('check runs', String(checks.total_count)))
      }

      if (allChecks.length > 0) {
        const rows = allChecks.map(check => [
          check.name,
          summarizeCheck(check),
          check.details_url,
        ])
        lines.push('', section('Checks', table(['Name', 'Result', 'URL'], rows)))

        const failing = allChecks.filter(check => isFailing(check))
        if (failing.length > 0) {
          lines.push(
            '',
            `## ${failing.length} failing:`,
            '',
            failing.map(check => `- ${check.name}`).join('\n'),
          )
        } else if (allChecks.every(check => check.conclusion === 'success')) {
          lines.push('', '## Overall: all checks passed')
        } else {
          lines.push('', '## Overall: checks still running')
        }
      } else {
        lines.push('', section('Checks', '- (no statuses or check runs for this ref)'))
      }

      lines.push(
        '',
        '## Suggested next steps',
        '',
        '- For a failing check, read its details URL and fix before asking for review.',
        '- For a PR, failing checks are a blocker for merging; for a draft PR they are expected to be worked through.',
      )
      return lines.join('\n')
    },
  }))
}

function summarizeCheck(check: GitHubCheckRun): string {
  if (check.status === 'queued') return 'queued'
  if (check.status === 'in_progress') return 'running'
  const conclusion = check.conclusion ?? 'unknown'
  const verdicts: Record<string, string> = {
    success: 'passed',
    failure: 'failed',
    neutral: 'neutral',
    cancelled: 'cancelled',
    skipped: 'skipped',
    timed_out: 'timed out',
    action_required: 'action required',
    stale: 'stale',
  }
  return verdicts[conclusion] ?? conclusion
}

function isFailing(check: GitHubCheckRun): boolean {
  return ['failure', 'timed_out', 'action_required'].includes(check.conclusion ?? '')
}
