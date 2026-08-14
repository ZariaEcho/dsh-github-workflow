/**
 * `gh_get_repo_context` — one-call orientation in an unfamiliar repository.
 *
 * Repository metadata (default branch, language, activity), recent commits on
 * the default branch, open pull request / issue counts, plus slow-moving
 * governance facts: CODEOWNERS and default-branch protection. The governance
 * facts are cached per repository for `contextCacheTtlMs`. Read-only.
 *
 * @module dsh-github-workflow/tools/get-repo-context
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { GitHubBranchProtection, GitHubClient, ToolDeps } from '../github-client.ts'
import { cachedRepoFacts } from '../utils/cache.ts'
import { TEXT_OUTPUT, firstLine, kv, relativeTime, section, shortSha } from '../utils/format.ts'

const CODEOWNERS_PATHS = ['.github/CODEOWNERS', 'docs/CODEOWNERS', 'CODEOWNERS']
const CODEOWNERS_MAX_LINES = 12

/** Register the tool. */
export function registerGetRepoContextTool(ctx: Context, deps: ToolDeps): void {
  ctx.tools.register(defineTool({
    name: 'gh_get_repo_context',
    description:
      'Orient in a GitHub repository: metadata (description, default branch, language, stars), recent commits on the default branch, open pull request / issue counts, CODEOWNERS rules, and default-branch protection. Read-only; governance facts are cached per repository.',
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
      const repo = await client.getRepo(args.owner, args.repo)
      const [commits, openPulls, governance] = await Promise.all([
        client.listCommits(args.owner, args.repo, '', depth).catch(() => []),
        client.searchIssues(`repo:${args.owner}/${args.repo} is:pr is:open`, 1).catch(() => undefined),
        cachedRepoFacts(
          `repo-context:${args.owner}/${args.repo}`,
          deps.config.contextCacheTtlMs,
          () => fetchGovernance(client, args.owner, args.repo, repo.default_branch),
          deps.cacheNs,
        ),
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

      if (governance.codeowners !== undefined) {
        lines.push('', section(`CODEOWNERS (${governance.codeowners.path})`, governance.codeowners.rules))
      } else {
        lines.push('', section('CODEOWNERS', '- (not found)'))
      }

      if (governance.protection !== undefined) {
        lines.push('', section('Branch protection (default branch)', governance.protection))
      } else if (governance.protectionChecked) {
        lines.push('', section('Branch protection', '- (not protected)'))
      } else {
        lines.push('', section('Branch protection', '- (unknown — a token with repo scope is needed to read it)'))
      }

      if (commits.length > 0) {
        lines.push(
          '',
          `## Recent commits on ${repo.default_branch} (${commits.length})`,
          '',
          commits.map(commit =>
            `- ${shortSha(commit.sha)} (${relativeTime(commit.commit.author.date)}, @${commit.author?.login ?? '–'}): ${firstLine(commit.commit.message, 100)}`,
          ).join('\n'),
        )
      }

      lines.push(
        '',
        '## Suggested next steps',
        '',
        '- Run gh_analyze_issue on the issue at hand, then gh_search_related for duplicates or similar prior work.',
        '- After implementing, use gh_create_draft_pr, then gh_check_ci_status on the draft.',
        '- Respect CODEOWNERS: they approve changes to their paths before merge.',
        '- Note: this tool cannot see the local checkout — combine it with filesystem tools for the full picture.',
      )

      return lines.join('\n')
    },
  }))
}

interface Governance {
  readonly codeowners: { path: string; rules: string } | undefined
  readonly protection: string | undefined
  readonly protectionChecked: boolean
}

/** CODEOWNERS + branch protection for one repo (the cached unit). */
async function fetchGovernance(
  client: GitHubClient,
  owner: string,
  repo: string,
  defaultBranch: string,
): Promise<Governance> {
  let codeowners: { path: string; rules: string } | undefined
  for (const path of CODEOWNERS_PATHS) {
    let text: string | undefined
    try {
      text = await client.getFileContentRaw(owner, repo, path)
    } catch {
      text = undefined
    }
    if (text !== undefined) {
      const rules = text
        .split('\n')
        .map(line => line.trim())
        .filter(line => line.length > 0 && !line.startsWith('#'))
        .slice(0, CODEOWNERS_MAX_LINES)
        .map(line => line.length > 120 ? `${line.slice(0, 120)}…` : line)
      codeowners = { path, rules: rules.length > 0 ? rules.join('\n') : '(empty file)' }
      break
    }
  }

  let protection: string | undefined
  let protectionChecked = false
  try {
    const branchProtection = await client.getBranchProtection(owner, repo, defaultBranch)
    if (branchProtection === null) {
      protectionChecked = true
    } else {
      protection = renderProtection(branchProtection)
    }
  } catch {
    // 403 without a token, network trouble, etc.: leave both flags false.
  }

  return { codeowners, protection, protectionChecked }
}

function renderProtection(protection: GitHubBranchProtection): string {
  const lines: string[] = []
  const reviews = protection.required_pull_request_reviews
  if (reviews !== undefined) {
    lines.push(`- required approvals: ${reviews.required_approving_review_count ?? 0}`)
    if (reviews.dismiss_stale_reviews === true) lines.push('- stale reviews dismissed on push')
  }
  const checks = protection.required_status_checks
  if (checks !== undefined) {
    lines.push(`- required status checks (${checks.contexts.length}): ${checks.contexts.join(', ') || 'none'}`)
    if (checks.strict === true) lines.push('- strict: branch must be up to date')
  }
  if (protection.enforce_admins?.enabled === true) lines.push('- enforced for administrators')
  if (protection.required_linear_history?.enabled === true) lines.push('- linear history required')
  if (protection.allow_force_pushes?.enabled === true) lines.push('- force pushes allowed')
  if (protection.allow_deletions?.enabled === true) lines.push('- deletions allowed')
  if (protection.restrictions === null) lines.push('- no push restrictions')
  return lines.length > 0 ? lines.join('\n') : '(protected, no review/status restrictions)'
}
