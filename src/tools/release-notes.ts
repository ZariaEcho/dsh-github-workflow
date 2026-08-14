/**
 * `gh_generate_release_notes` — draft release notes from merged pull requests
 * between two refs (tags or branches).
 *
 * Uses the compare API for the range and the issue search for merged PRs
 * (`merged:<from>..<to>`), then filters client-side by `merged_at` for exact
 * boundaries. Read-only; the result is a changelog draft the agent can edit.
 *
 * @module dsh-github-workflow/tools/release-notes
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { GitHubSearchResult, ToolDeps } from '../github-client.ts'
import { TEXT_OUTPUT, kv, relativeTime, section } from '../utils/format.ts'

const MAX_ITEMS = 100

/** Register the tool. */
export function registerReleaseNotesTool(ctx: Context, deps: ToolDeps): void {
  ctx.tools.register(defineTool({
    name: 'gh_generate_release_notes',
    description:
      'Draft release notes from merged pull requests between two refs (tags or branches): a chronologically sorted changelog with PR numbers, titles, authors, and labels. Read-only.',
    parameters: {
      owner: { type: 'string', required: true, description: 'Repository owner (user or organization).' },
      repo: { type: 'string', required: true, description: 'Repository name.' },
      from: { type: 'string', required: true, description: 'Base ref or tag, e.g. v1.0.0 (exclusive lower bound).' },
      to: { type: 'string', description: 'Upper ref or tag. Defaults to the repository default branch.' },
      limit: { type: 'integer', description: 'Maximum entries. Defaults to 100 (1–100).' },
    },
    output: TEXT_OUTPUT,
    timeoutMs: deps.config.timeoutMs + 30_000,
    isConcurrencySafe: () => true,
    async execute(args, _exec) {
      const limit = Math.min(Math.max(args.limit ?? MAX_ITEMS, 1), MAX_ITEMS)
      const client = await deps.client()

      const repo = await client.getRepo(args.owner, args.repo)
      const toRef = args.to ?? repo.default_branch
      if (args.from === toRef) {
        return '## Invalid arguments\n\n`from` and `to` resolve to the same ref — nothing to release.'
      }

      const compare = await client.getCompare(args.owner, args.repo, args.from, toRef)
      const [fromCommit, toCommit] = await Promise.all([
        client.getCommit(args.owner, args.repo, args.from),
        client.getCommit(args.owner, args.repo, toRef),
      ])
      const fromDate = (fromCommit.commit.author.date ?? '').slice(0, 10)
      const toDate = (toCommit.commit.author.date ?? '').slice(0, 10)
      if (fromDate.length === 0 || toDate.length === 0) {
        return '## Release notes unavailable\n\nCould not read commit dates for the refs.'
      }

      let search: GitHubSearchResult
      try {
        search = await client.searchIssues(
          `repo:${args.owner}/${args.repo} is:pr is:merged merged:${fromDate}..${toDate}`,
          limit,
        )
      } catch (error) {
        return `# Release notes failed\n\n${String(error)}`
      }

      const fromMillis = Date.parse(`${fromDate}T00:00:00Z`)
      const toMillis = Date.parse(`${toDate}T23:59:59Z`)
      const items = search.items
        .filter(item => {
          const mergedAt = item.pull_request?.merged_at
          if (mergedAt === undefined || mergedAt === null) return false
          const millis = Date.parse(mergedAt)
          return !Number.isNaN(millis) && millis >= fromMillis && millis <= toMillis
        })
        .sort((a, b) => Date.parse(a.pull_request?.merged_at ?? '') - Date.parse(b.pull_request?.merged_at ?? ''))

      const lines: string[] = [
        `# Release notes — ${args.owner}/${args.repo}`,
        '',
        kv('range', `${args.from} → ${toRef}`),
        kv('commits ahead', String(compare.ahead_by)),
        kv('merged pull requests', String(items.length)),
        kv('search window', `${fromDate}..${toDate}`),
      ]

      if (items.length > 0) {
        const rendered = items.map(item => {
          const labels = item.labels.map(label => label.name).join(', ')
          return `- #${item.number} ${item.title} — @${item.user?.login ?? 'ghost'}, merged ${relativeTime(item.pull_request?.merged_at ?? null)}${labels ? `, labels: ${labels}` : ''}`
        })
        lines.push('', section('Merged pull requests', rendered.join('\n')))
      } else {
        lines.push('', section('Merged pull requests', '- (none found in this range)'))
      }

      lines.push(
        '',
        '## Suggested next steps',
        '',
        '- Review and group the entries (features / bug fixes / docs) before publishing.',
        '- Publish the release through the GitHub web UI or gh CLI when ready.',
      )

      return lines.join('\n')
    },
  }))
}
