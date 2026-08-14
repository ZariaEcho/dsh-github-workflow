/**
 * `gh_analyze_issue` — deep analysis of one GitHub issue.
 *
 * Fetches the issue, its comments, best-effort linked pull requests, and
 * (when a token is available) code references for identifiers mentioned in
 * the body. The output organizes facts under the four analysis dimensions —
 * problem understanding, impact scope, implementation suggestions, potential
 * risks — and leaves the final judgment to the agent.
 *
 * @module dsh-github-workflow/tools/analyze-issue
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { GitHubIssue, GitHubSearchResult, ToolDeps } from '../github-client.ts'
import { TEXT_OUTPUT, bullet, extractBullets, extractIssueRefs, firstLine, kv, relativeTime, section, truncate } from '../utils/format.ts'

const BODY_MAX = 4000
const COMMENT_BODY_MAX = 600

/** Register the tool. */
export function registerAnalyzeIssueTool(ctx: Context, deps: ToolDeps): void {
  ctx.tools.register(defineTool({
    name: 'gh_analyze_issue',
    description:
      'Deep analysis of one GitHub issue: returns the issue body, comments, candidate requirements, best-effort linked pull requests, and code references, organized into an analysis scaffold covering problem understanding, impact scope, implementation suggestions, and potential risks.',
    parameters: {
      owner: { type: 'string', required: true, description: 'Repository owner (user or organization).' },
      repo: { type: 'string', required: true, description: 'Repository name.' },
      issueNumber: { type: 'integer', required: true, description: 'Issue number to analyze.' },
    },
    output: TEXT_OUTPUT,
    timeoutMs: deps.config.timeoutMs + 20_000,
    isConcurrencySafe: () => true,
    async execute(args, _exec) {
      const client = await deps.client()
      const issue = await client.getIssue(args.owner, args.repo, args.issueNumber)
      const commentPage = await client.listIssueComments(args.owner, args.repo, args.issueNumber)

      const keywords = extractKeywords(issue)

      // Best-effort linked pull requests (PRs referencing this issue):
      // search is cheap and may be rate limited anonymously; tolerate failure.
      let linked: GitHubSearchResult | undefined
      try {
        linked = await client.searchIssues(
          `repo:${args.owner}/${args.repo} is:pr #${args.issueNumber}`,
          5,
        )
      } catch {
        linked = undefined
      }

      // Best-effort historical pull requests: PRs solving a similar problem,
      // found by title/body keywords, excluding the linked set.
      let historyPrs: GitHubSearchResult | undefined
      if (keywords.length > 0) {
        try {
          historyPrs = await client.searchIssues(
            `repo:${args.owner}/${args.repo} is:pr ${keywords.join(' ')}`,
            5,
          )
        } catch {
          historyPrs = undefined
        }
      }

      // Best-effort similar issues: duplicates and related reports, found by
      // the same keywords, excluding the analyzed issue itself.
      let similar: GitHubSearchResult | undefined
      if (keywords.length > 0) {
        try {
          similar = await client.searchIssues(
            `repo:${args.owner}/${args.repo} is:issue ${keywords.join(' ')}`,
            5,
          )
        } catch {
          similar = undefined
        }
      }

      // Best-effort code references: identifiers in backticks, searched only
      // with a token (code search requires authentication).
      let codeRefs: string[] = []
      if (client.authenticated) {
        const identifiers = extractIdentifiers(issue.body ?? '')
        for (const identifier of identifiers.slice(0, 2)) {
          try {
            const result = await client.searchCode(
              `repo:${args.owner}/${args.repo} ${identifier} in:file`,
              5,
            )
            for (const item of result.items) codeRefs.push(`\`${identifier}\` → ${item.path}`)
          } catch {
            // Rate limited or no code-search permission: skip quietly.
          }
        }
      }

      return renderAnalysis(
        args, issue, commentPage.items, commentPage.truncated,
        linked, historyPrs, similar, codeRefs, client.authenticated, keywords,
      )
    },
  }))
}

interface RenderArgs {
  readonly owner: string
  readonly repo: string
  readonly issueNumber: number
}

function renderAnalysis(
  args: RenderArgs,
  issue: GitHubIssue,
  comments: Array<{ user: { login: string } | null; body: string; created_at: string }>,
  commentsTruncated: boolean,
  linked: GitHubSearchResult | undefined,
  historyPrs: GitHubSearchResult | undefined,
  similar: GitHubSearchResult | undefined,
  codeRefs: string[],
  authenticated: boolean,
  keywords: readonly string[],
): string {
  const labels = issue.labels.map(label => label.name).join(', ') || '–'
  const lines: string[] = [
    `# Issue #${issue.number} — ${issue.title}`,
    '',
    kv('repo', `${args.owner}/${args.repo}`),
    kv('state', issue.state + (issue.pull_request !== undefined ? ' (this is a pull request)' : '')),
    kv('labels', labels),
    kv('author', issue.user?.login ?? '–'),
    kv('opened', relativeTime(issue.created_at)),
    kv('updated', relativeTime(issue.updated_at)),
    kv('comments', String(issue.comments)),
    kv('milestone', issue.milestone?.title ?? '–'),
    kv('auth', authenticated ? 'authenticated' : 'anonymous (code search skipped; 60 req/h rate limit)'),
  ]

  lines.push('', section('Body', truncate(issue.body ?? '(no body)', BODY_MAX)))

  const requirements = extractBullets(issue.body)
  if (requirements.length > 0) {
    lines.push('', section('Candidate requirements (bullets in the issue body)', bullet(requirements)))
  }

  if (comments.length > 0) {
    const rendered = comments.map(comment =>
      `- @${comment.user?.login ?? 'ghost'} (${relativeTime(comment.created_at)}): ${firstLine(comment.body, COMMENT_BODY_MAX)}`,
    )
    lines.push('', section(`Comments (${comments.length}${commentsTruncated ? '+ truncated' : ''})`, rendered.join('\n')))
  }

  if (linked !== undefined && linked.items.length > 0) {
    const rendered = linked.items.map(item => {
      const merged = item.pull_request?.merged_at !== undefined && item.pull_request.merged_at !== null
        ? ' [merged]'
        : item.state === 'open' ? ' [open]' : ' [closed]'
      return `- #${item.number}${merged}: ${item.title}`
    })
    lines.push('', section('Linked pull requests (PRs referencing this issue)', rendered.join('\n')))
  }

  const historyItems = (historyPrs?.items ?? []).filter(item => item.number !== issue.number)
  if (historyItems.length > 0) {
    const rendered = historyItems.map(item => {
      const merged = item.pull_request?.merged_at !== undefined && item.pull_request.merged_at !== null
        ? ' [merged]'
        : item.state === 'open' ? ' [open]' : ' [closed]'
      return `- #${item.number}${merged}: ${item.title} (updated ${relativeTime(item.updated_at)})`
    })
    lines.push('', section('Historical pull requests (similar keywords, best-effort)', rendered.join('\n')))
  }

  const similarItems = (similar?.items ?? []).filter(item => item.number !== issue.number)
  if (similarItems.length > 0) {
    const rendered = similarItems.map(item => {
      const labels = item.labels.map(label => label.name).join(', ')
      return `- #${item.number} [${item.state}]: ${item.title} (updated ${relativeTime(item.updated_at)}, comments: ${item.comments}${labels ? `, labels: ${labels}` : ''})`
    })
    lines.push('', section('Similar issues (duplicates & related, best-effort)', rendered.join('\n')))
  }

  if (codeRefs.length > 0) {
    lines.push('', section('Code references (identifiers from the body)', bullet(codeRefs)))
  }

  lines.push(
    '',
    section(
      'Analysis scaffold — complete every section for the final analysis',
      [
        '### Problem understanding',
        '- What is the reported problem or requested feature, in one paragraph?',
        '- What is the expected behavior? What is the current behavior?',
        '',
        '### Impact scope',
        '- Which components, modules, or files are affected?',
        '- Which users or features are affected?',
        '- Is the change breaking (API, data, behavior)?',
        '',
        '### Implementation suggestions',
        '- Proposed approach with concrete steps.',
        '- Files most likely to change.',
        '- Tests that should be added or updated.',
        '',
        '### Potential risks',
        '- Edge cases and failure modes.',
        '- Regressions or performance concerns.',
        '- Anything that needs human decision before coding.',
        '',
        `Search keywords used: ${keywords.join(', ') || 'none'}`,
        `Refs mentioned in this issue: ${extractIssueRefs(issue.body ?? '').map(n => `#${n}`).join(', ') || 'none'}`,
      ].join('\n'),
    ),
  )

  if (issue.pull_request !== undefined) {
    lines.push('', `> Tip: #${issue.number} is itself a pull request — use gh_review_pr to review it.`)
  }

  return lines.join('\n')
}

/** Backticked identifiers and bare function-like tokens from a body. */
function extractIdentifiers(body: string): string[] {
  const found: string[] = []
  const seen = new Set<string>()
  for (const match of body.matchAll(/`([A-Za-z_][A-Za-z0-9_.]*)`/g)) {
    const identifier = match[1]
    if (identifier === undefined) continue
    if (identifier.includes('.')) continue
    if (seen.has(identifier)) continue
    seen.add(identifier)
    found.push(identifier)
    if (found.length >= 4) break
  }
  return found
}

/** English stopwords too generic to search for. */
const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'this', 'that', 'from', 'have', 'has', 'had', 'are',
  'was', 'were', 'will', 'would', 'should', 'could', 'when', 'after', 'before',
  'issue', 'issues', 'problem', 'problems', 'fix', 'fixed', 'fixes', 'feature',
  'request', 'support', 'need', 'needs', 'should', 'currently', 'expected',
])

/**
 * Search keywords from an issue's title and body. ASCII first: alphanumeric
 * tokens of 4–24 chars, stopwords and pure numbers dropped, deduped, longest
 * first, up to three. When no ASCII token survives (typical for CJK issues),
 * fall back to up to two CJK phrases (2–30 consecutive Han characters) from
 * the title and body, so similar-issue and historical-PR search still works
 * for Chinese-language repositories.
 */
function extractKeywords(issue: { title: string; body: string | null }): string[] {
  const seen = new Set<string>()
  const tokens: string[] = []
  const push = (text: string): void => {
    for (const raw of text.toLowerCase().split(/[^a-z0-9]+/)) {
      const token = raw.trim()
      if (token.length < 4 || token.length > 24) continue
      if (STOPWORDS.has(token)) continue
      if (/^\d+$/.test(token)) continue
      if (seen.has(token)) continue
      seen.add(token)
      tokens.push(token)
    }
  }
  push(issue.title)
  push(issue.body ?? '')
  if (tokens.length > 0) {
    return tokens.sort((a, b) => b.length - a.length).slice(0, 3)
  }
  return collectCjkPhrases(`${issue.title} ${issue.body ?? ''}`)
}

/** Consecutive Han-character runs of 2–30 chars, deduped, up to two. */
function collectCjkPhrases(text: string): string[] {
  const phrases: string[] = []
  const seen = new Set<string>()
  for (const match of text.matchAll(/[\u4e00-\u9fff]{2,30}/g)) {
    const phrase = match[0]
    if (phrase === undefined || seen.has(phrase)) continue
    seen.add(phrase)
    phrases.push(phrase)
    if (phrases.length >= 2) break
  }
  return phrases
}
