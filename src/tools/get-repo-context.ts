/**
 * `gh_get_repo_context` — one-call orientation in an unfamiliar repository.
 *
 * Repository metadata (default branch, language, activity), recent commits on
 * the default branch, and open pull request / issue counts. Read-only.
 *
 * @module dsh-github-workflow/tools/get-repo-context
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDeps } from '../github-client.ts'
import { firstLine, kv, relativeTime, shortSha } from '../utils/format.ts'

const TEXT_OUTPUT = {
  schema: { type: 'string' as const },
  render: (_args: unknown, value: string) => [{ type: 'text' as const, text: value }],
}

/** Register the tool. */
export function registerGetRepoContextTool(ctx: Context, deps: ToolDeps): void {
  ctx.tools.register(defineTool({
    name: 'gh_get_repo_context',
    description:
      'Orient in a GitHub repository: metadata (description, default branch, language, stars), recent commits on the default branch, and open pull request / issue counts. Read-only.',
    parameters: {
      owner: { type: 'string', required: true, description: 'Repository owner (user or organization).' },
      repo: { type: 'string', required: true, description: 'Repository name.' },
      depth: { type: 'integer', description: 'Number of recent commits to list. Defaults to 10 (1–30).' },
    },
    output: TEXT_OUTPUT,
    timeoutMs: deps.config.timeoutMs + 20_000,
    isConcurrencySafe: () => true,
    async execute(args, _exec) {
      const depth = Math.min(Math.max(args.depth ?? 10, 1), 30)
      const client = await deps.client()
      const [repo, commits, openPulls] = await Promise.all([
        client.getRepo(args.owner, args.repo),
        client.listCommits(args.owner, args.repo, '', depth).catch(() => []),
        client.searchIssues(`repo:${args.owner}/${args.repo} is:pr is:open`, 1).catch(() => undefined),
      ])

      const lines: string[] = [
        `# ${repo.full_name}`,
        '',
        kv('description', repo.description ?? '–'),
        kv('language', repo.language ?? '–'),
        kv('default branch', repo.default_branch),
        kv('stars', String(repo.stargazers_count)),
        kv('forks', String(repo.forks_count)),
        kv('open issues', String(repo.open_issues_count)),
        kv('open pull requests', String(openPulls?.total_count ?? '–')),
        kv('archived', String(repo.archived)),
        kv('topics', repo.topics.join(', ') || '–'),
        kv('url', repo.html_url),
      ]

      if (commits.length > 0) {
        const rows = commits.map(commit => [
          shortSha(commit.sha),
          relativeTime(commit.commit.author.date),
          commit.author?.login ?? '–',
          firstLine(commit.commit.message, 100),
        ])
        lines.push(
          '',
          `## Recent commits on ${repo.default_branch} (${commits.length})`,
          '',
          rows.map(row => `- ${row[0]} (${row[1]}, @${row[2]}): ${row[3]}`).join('\n'),
        )
      }

      lines.push(
        '',
        '## Suggested next steps',
        '',
        '- Run gh_analyze_issue on the issue at hand, then gh_search_related for duplicates or similar prior work.',
        '- After implementing, use gh_create_draft_pr, then gh_check_ci_status on the draft.',
        '- Note: this tool cannot see the local checkout — combine it with filesystem tools for the full picture.',
      )

      return lines.join('\n')
    },
  }))
}
