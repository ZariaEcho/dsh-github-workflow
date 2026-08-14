/**
 * `gh_search_related` — find related issues and pull requests before doing
 * work (duplicates, similar prior attempts, tracking issues). Read-only.
 *
 * @module dsh-github-workflow/tools/search-related
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { GitHubSearchResult, ToolDeps } from '../github-client.ts'
import { TEXT_OUTPUT, kv, relativeTime, section } from '../utils/format.ts'

/** Register the tool. */
export function registerSearchRelatedTool(ctx: Context, deps: ToolDeps): void {
  ctx.tools.register(defineTool({
    name: 'gh_search_related',
    description:
      'Search GitHub issues and pull requests for related work (duplicates, prior attempts, tracking issues). Optionally scoped to one repository.',
    parameters: {
      query: { type: 'string', required: true, description: 'Free-text search query, e.g. "rate limit reset" or "webhook signature verification".' },
      owner: { type: 'string', description: 'Restrict the search to this owner (organization or user).' },
      repo: { type: 'string', description: 'Restrict the search to this repository (requires owner).' },
      type: { type: 'string', enum: ['issue', 'pull', 'both'], description: 'What to search. Defaults to both.' },
      limit: { type: 'integer', description: 'Maximum results. Defaults to 8 (1–20).' },
    },
    output: TEXT_OUTPUT,
    timeoutMs: deps.config.timeoutMs + 15_000,
    isConcurrencySafe: () => true,
    async execute(args, _exec) {
      const limit = Math.min(Math.max(args.limit ?? 8, 1), 20)
      const client = await deps.client()

      const qualifiers: string[] = []
      if (args.owner !== undefined && args.repo !== undefined) {
        qualifiers.push(`repo:${args.owner}/${args.repo}`)
      } else if (args.owner !== undefined) {
        qualifiers.push(`user:${args.owner}`)
      }
      if (args.type === 'issue') qualifiers.push('is:issue')
      if (args.type === 'pull') qualifiers.push('is:pr')

      const query = [args.query, ...qualifiers].join(' ')
      let result: GitHubSearchResult
      try {
        result = await client.searchIssues(query, limit)
      } catch (error) {
        return `# Search failed\n\n${String(error)}`
      }

      const lines: string[] = [
        `# Search: "${args.query}"`,
        '',
        kv('scope', qualifiers.join(' ') || 'all of GitHub'),
        kv('hits', String(result.total_count)),
        kv('auth', client.authenticated ? 'authenticated' : 'anonymous (60 req/h rate limit)'),
      ]

      if (result.items.length > 0) {
        const rows = result.items.map(item => {
          const kind = item.pull_request !== undefined ? 'pr' : 'issue'
          const merged = item.pull_request?.merged_at !== null && item.pull_request?.merged_at !== undefined
            ? ' merged'
            : item.state === 'open' ? ' open' : ' closed'
          const labels = item.labels.map(label => label.name).join(', ')
          return [
            `#${item.number}`,
            kind + merged,
            item.title,
            relativeTime(item.updated_at),
            String(item.comments),
            labels || '–',
          ]
        })
        lines.push(
          '',
          section(
            'Results',
            rows.map(row =>
              `- ${row[0]} [${row[1]}] ${row[2]} — updated ${row[3]}, ${row[4]} comments, labels: ${row[5]}`,
            ).join('\n'),
          ),
        )
      } else {
        lines.push('', section('Results', '- (no matches)'))
      }

      lines.push(
        '',
        '## Suggested next steps',
        '',
        '- Check the open results for duplicates before implementing.',
        '- If a closed item solved the same problem, read it and link it in the new issue/PR.',
      )
      return lines.join('\n')
    },
  }))
}
