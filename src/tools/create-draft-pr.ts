/**
 * `gh_create_draft_pr` — create a draft pull request with a standardized,
 * diff-grounded description.
 *
 * Sources for title/body, in priority order:
 * 1. Explicit `title` / `body` arguments.
 * 2. The linked `issueNumber`: title from the issue, body scaffold with a
 *    `Closes #N` line.
 * 3. The actual change: derived from `base...head` compare — commit messages
 *    and the file diff — so a bare branch name still produces a well-formed
 *    draft PR description.
 *
 * This is a mutating tool: it is gated by the permission choke point
 * (read-only mode, approval, token scopes).
 *
 * @module dsh-github-workflow/tools/create-draft-pr
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { GitHubCompare, GitHubIssue, ToolDeps } from '../github-client.ts'
import { cachedRepoFacts, invalidateRepo } from '../utils/cache.ts'
import { TEXT_OUTPUT, diffStat, extractIssueRefs, firstLine, kv, shortSha, table } from '../utils/format.ts'
import { prepareMutation } from '../utils/permission.ts'
import { traceOperation } from '../utils/trace.ts'

/** Register the tool. */
export function registerCreateDraftPrTool(ctx: Context, deps: ToolDeps): void {
  ctx.tools.register(defineTool({
    name: 'gh_create_draft_pr',
    description:
      'Create a draft pull request with a standardized description. Title and body are derived from the linked issue or from the actual base...head diff when not given explicitly. Mutating: gated by read-only mode, user approval, and token scopes.',
    parameters: {
      owner: { type: 'string', required: true, description: 'Repository owner (user or organization).' },
      repo: { type: 'string', required: true, description: 'Repository name.' },
      head: { type: 'string', required: true, description: 'The head branch containing the changes (e.g. feat/issue-42).' },
      base: { type: 'string', description: 'Target base branch. Defaults to the repository default branch.' },
      issueNumber: { type: 'integer', description: 'Linked issue; its title feeds the PR title and a "Closes #N" line is added.' },
      title: { type: 'string', description: 'Explicit PR title (overrides derivation).' },
      body: { type: 'string', description: 'Explicit PR body (overrides derivation).' },
      draft: { type: 'boolean', description: 'Create as draft. Defaults to true.' },
    },
    output: TEXT_OUTPUT,
    timeoutMs: deps.config.timeoutMs + 30_000,
    async execute(args, exec) {
      const prepared = await prepareMutation(deps, exec, 'create draft pull request')
      if ('denied' in prepared) return prepared.denied
      const client = prepared.client

      const base = args.base ?? (await client.getRepo(args.owner, args.repo)).default_branch
      if (!(await client.branchExists(args.owner, args.repo, args.head))) {
        return `## Mutation blocked\n\nHead branch "${args.head}" does not exist in ${args.owner}/${args.repo}. Push it first (or check the branch name).`
      }

      let issue: GitHubIssue | undefined
      if (args.issueNumber !== undefined) {
        try {
          issue = await client.getIssue(args.owner, args.repo, args.issueNumber)
        } catch {
          issue = undefined
        }
      }

      const [compare, template] = await Promise.all([
        client.getCompare(args.owner, args.repo, base, args.head),
        cachedRepoFacts(
          `pr-template:${args.owner}/${args.repo}`,
          deps.config.contextCacheTtlMs,
          () => fetchPrTemplate(client, args.owner, args.repo),
          deps.cacheNs,
        ),
      ])
      const title = resolveTitle(args, issue, compare)
      const body = resolveBody(args, issue, compare, template)

      const pr = await client.createPullRequest(args.owner, args.repo, {
        title,
        head: args.head,
        base,
        body,
        draft: args.draft ?? true,
      })

      invalidateRepo(args.owner, args.repo, deps.cacheNs)

      traceOperation(ctx, exec, {
        operation: 'create_draft_pr',
        outcome: 'success',
        owner: args.owner,
        repo: args.repo,
        number: pr.number,
        url: pr.html_url,
        detail: `${pr.head.ref} → ${pr.base.ref} (draft: ${String(pr.draft)})`,
      })

      const lines = [
        `# Draft pull request #${pr.number} created`,
        '',
        kv('url', pr.html_url),
        kv('title', pr.title),
        kv('branch', `${pr.head.ref} → ${pr.base.ref}`),
        kv('draft', String(pr.draft)),
        kv('description source', describeSource(args, issue, template)),
      ]
      if (pr.draft) {
        lines.push('', '> The PR is a draft. Mark it ready for review when the implementation is complete.')
      }
      return lines.join('\n')
    },
  }))
}

const PR_TEMPLATE_PATHS = ['.github/pull_request_template.md', 'docs/pull_request_template.md', 'pull_request_template.md']

interface PrTemplate {
  readonly path: string
  readonly text: string
}

/** Repository PR template, first match of the three canonical locations. */
async function fetchPrTemplate(
  client: import('../github-client.ts').GitHubClient,
  owner: string,
  repo: string,
): Promise<PrTemplate | undefined> {
  for (const path of PR_TEMPLATE_PATHS) {
    let text: string | undefined
    try {
      text = await client.getFileContentRaw(owner, repo, path)
    } catch {
      text = undefined
    }
    if (text !== undefined && text.trim().length > 0) {
      return { path, text: text.trim() }
    }
  }
  return undefined
}

function describeSource(
  args: { title?: string; body?: string; issueNumber?: number },
  issue: GitHubIssue | undefined,
  template: PrTemplate | undefined,
): string {
  const templateNote = template !== undefined ? ` + ${template.path}` : ''
  if (args.title !== undefined && args.body !== undefined) return 'explicit title + body'
  if (args.title !== undefined) return `explicit title, diff-derived body${templateNote}`
  if (issue !== undefined) return `issue #${issue.number}${templateNote}`
  return `base...head diff${templateNote}`
}

function resolveTitle(
  args: { title?: string; issueNumber?: number; head: string },
  issue: GitHubIssue | undefined,
  compare: GitHubCompare,
): string {
  if (args.title !== undefined && args.title.trim().length > 0) return args.title.trim()
  if (issue !== undefined && issue.title.trim().length > 0) return issue.title.trim()
  const latestMessage = compare.commits[0]?.commit.message ?? ''
  const firstCommitLine = latestMessage.split('\n').find(line => line.trim().length > 0)?.trim()
  if (firstCommitLine !== undefined && firstCommitLine.length > 0) return firstCommitLine.slice(0, 72)
  return args.head.slice(0, 72)
}

function resolveBody(
  args: { body?: string; issueNumber?: number; head: string },
  issue: GitHubIssue | undefined,
  compare: GitHubCompare,
  template: PrTemplate | undefined,
): string {
  if (args.body !== undefined && args.body.trim().length > 0) return args.body

  const derived = buildDerivedBody(args, issue, compare)
  if (template !== undefined) {
    return `${template.text}\n\n---\n\n${derived}`
  }
  return derived
}

function buildDerivedBody(
  args: { issueNumber?: number; head: string },
  issue: GitHubIssue | undefined,
  compare: GitHubCompare,
): string {
  const latestMessage = compare.commits[0]?.commit.message ?? ''
  const latestFirstLine = latestMessage.split('\n').find(line => line.trim().length > 0)?.trim() ?? ''

  const sections: string[] = []
  if (issue !== undefined) {
    const body = issue.body ?? ''
    sections.push('## Summary', '', body.trim().length > 0 ? body.slice(0, 2000) : `Implements the request in issue #${issue.number}.`)
  } else if (latestFirstLine.length > 0) {
    sections.push('## Summary', '', latestFirstLine.slice(0, 500))
  } else {
    sections.push('## Summary', '', 'Describe the change and why it is needed.')
  }

  sections.push('', '## Changes')
  if (compare.files.length === 0) {
    sections.push('', '- (no file changes between base and head)')
  } else {
    const rows = compare.files.slice(0, 40).map(file => [
      `\`${file.filename}\``,
      `${file.status} ${diffStat(file.additions, file.deletions)}`,
    ])
    sections.push('', table(['File', 'Change'], rows))
    if (compare.files.length > 40) {
      sections.push('', `… and ${compare.files.length - 40} more files`)
    }
  }

  sections.push(
    '',
    '## Commits',
    '',
    compare.commits.slice(0, 20).map(commit => `- ${shortSha(commit.sha)} ${firstLine(commit.commit.message, 120)}`).join('\n'),
  )

  sections.push(
    '',
    '## Test plan',
    '',
    '- [ ] Run existing tests',
    '- [ ] Manual verification of the changed behavior',
  )

  const refs = collectRefs(args, issue, compare)
  if (refs.length > 0) {
    sections.push(
      '',
      '## Related',
      '',
      refs.map(number => `Closes #${number}`).join('\n'),
    )
  }

  return sections.join('\n')
}

/** Issue references from the issue number, branch name, and commit messages. */
function collectRefs(
  args: { issueNumber?: number; head: string },
  issue: GitHubIssue | undefined,
  compare: GitHubCompare,
): number[] {
  const refs = new Set<number>()
  if (args.issueNumber !== undefined) refs.add(args.issueNumber)
  if (issue !== undefined) {
    for (const number of extractIssueRefs(issue.body ?? '')) refs.add(number)
  }
  for (const number of extractIssueRefs(args.head)) refs.add(number)
  for (const commit of compare.commits) {
    for (const number of extractIssueRefs(commit.commit.message)) refs.add(number)
  }
  return [...refs].sort((a, b) => a - b).slice(0, 5)
}
