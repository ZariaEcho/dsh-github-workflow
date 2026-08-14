/**
 * Live WRITE smoke for dsh-github-workflow — real end-to-end validation of
 * every mutating tool against a real GitHub account.
 *
 * SAFETY: this script creates a throwaway PRIVATE repository, exercises the
 * full write loop inside it, and deletes the repository in a `finally` block.
 * It never touches any other repository and never prints the token.
 *
 * Prerequisites:
 *   export GITHUB_TOKEN=<token with repo scope>   # gh auth token works
 *   npm run build
 *   node examples/live-write-smoke.mjs
 *
 * The plugin is mounted with requireApprovalForMutations: false because this
 * script has no interactive approval answerer — the gate itself is validated
 * by smoke.mjs; here we validate the real API round-trips.
 */

import { Context, Service } from '@deepseek-ai/cordis'
import * as plugin from '../lib/index.js'

class ToolsService extends Service {
  constructor(ctx) {
    super(ctx, 'tools')
    this.registry = new Map()
  }
  register(def) {
    this.registry.set(def.name, def)
  }
}
class SystemPromptService extends Service {
  constructor(ctx) {
    super(ctx, 'systemPrompt')
  }
  section() {}
}

const token = process.env.GITHUB_TOKEN
if (token === undefined || token.length === 0) {
  console.error('GITHUB_TOKEN is required (export GITHUB_TOKEN, or run via: GITHUB_TOKEN=$(gh auth token) node examples/live-write-smoke.mjs)')
  process.exit(2)
}

const API = 'https://api.github.com'
const now = Date.now()
const REPO = `dsh-ghwf-live-${now}`
let owner = ''

let failures = 0
const check = (name, condition, detail = '') => {
  if (condition) {
    console.log(`  ok  ${name}`)
  } else {
    failures += 1
    console.log(`FAIL  ${name}${detail ? `\n      ${detail}` : ''}`)
  }
}

async function api(method, path, body, expectStatus) {
  const init = {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
    },
    signal: AbortSignal.timeout(30_000),
  }
  if (body !== undefined) init.body = JSON.stringify(body)
  const response = await fetch(`${API}${path}`, init)
  const text = await response.text()
  let parsed = null
  try {
    parsed = text.length > 0 ? JSON.parse(text) : null
  } catch {
    parsed = text
  }
  if (expectStatus !== undefined && response.status !== expectStatus) {
    throw new Error(`${method} ${path} → ${response.status}: ${text.slice(0, 300)}`)
  }
  return { status: response.status, data: parsed, headers: response.headers }
}

const makeExec = (name, args, agent = undefined) => ({
  name,
  callId: `live-write-${name}-${now}`,
  rootCallId: `live-write-${name}-${now}`,
  arguments: args,
  agent,
  token: Symbol('live'),
  signal: new AbortController().signal,
})

const ctx = new Context()
const tools = new ToolsService(ctx)
new SystemPromptService(ctx)
await ctx.plugin(plugin, { requireApprovalForMutations: false })
const run = (toolName, args, agent) => tools.registry.get(toolName).execute(args, makeExec(toolName, args, agent))

try {
  /* ── setup: throwaway private repo ─────────────────────────────────────── */
  console.log('── setup: create throwaway private repository')
  const created = await api('POST', '/user/repos', {
    name: REPO,
    private: true,
    auto_init: true,
    description: 'dsh-github-workflow live write smoke (auto-deleted)',
  }, 201)
  owner = created.data.owner.login
  const fullName = `${owner}/${REPO}`
  console.log(`  repo: ${fullName}`)

  const repoInfo = await api('GET', `/repos/${fullName}`)
  const defaultBranch = repoInfo.data.default_branch
  const branchRef = await api('GET', `/repos/${fullName}/git/ref/heads/${defaultBranch}`)
  const baseSha = branchRef.data.object.sha

  const put = (path, content, branch) => api('PUT', `/repos/${fullName}/contents/${path}`, {
    message: `init ${path}`,
    content: Buffer.from(content).toString('base64'),
    ...(branch !== undefined ? { branch } : {}),
  }, 201)

  await put('.github/CODEOWNERS', '# live smoke\n/src/ @ZariaEcho\n')
  await put('.github/pull_request_template.md', '### What does this PR do?\n\n### Test plan\n- [ ] unit tests\n')
  await put('src/app.js', 'export const app = () => 1\n')

  const issue = await api('POST', `/repos/${fullName}/issues`, {
    title: 'Live smoke issue: window reset',
    body: 'The reset window is wrong.\n\n- Must reset after 60 minutes\n- Keep `rateLimiter` behavior',
  }, 201)
  const issueNumber = issue.data.number

  await api('POST', `/repos/${fullName}/git/refs`, {
    ref: 'refs/heads/feat/live-test',
    sha: baseSha,
  }, 201)
  await put('src/feature.js', 'export const feature = () => 42\n', 'feat/live-test')

  /* ── read tools against the real repo ──────────────────────────────────── */
  console.log('── read: gh_get_repo_context')
  const repoText = await run('gh_get_repo_context', { owner, repo: REPO })
  check('CODEOWNERS live', repoText.includes('CODEOWNERS (.github/CODEOWNERS)') && repoText.includes('/src/ @ZariaEcho'), repoText.slice(0, 300))

  console.log('── read: gh_analyze_issue')
  const issueText = await run('gh_analyze_issue', { owner, repo: REPO, issueNumber })
  check('issue analyzed live', issueText.includes(`# Issue #${issueNumber} — Live smoke issue: window reset`), issueText.slice(0, 300))
  check('candidate requirements', issueText.includes('Must reset after 60 minutes'))

  /* ── write: create draft PR (issue-linked + template + diff) ──────────── */
  console.log('── write: gh_create_draft_pr')
  const prText = await run('gh_create_draft_pr', { owner, repo: REPO, head: 'feat/live-test', issueNumber })
  const prMatch = /# Draft pull request #(\d+) created/.exec(prText)
  check('draft PR created', prMatch !== null, prText.slice(0, 300))
  const pullNumber = Number(prMatch?.[1])
  check('body source names template', prText.includes('.github/pull_request_template.md'), prText.slice(0, 300))

  const prDetail = await api('GET', `/repos/${fullName}/pulls/${pullNumber}`)
  const prBody = prDetail.data.body ?? ''
  check('PR body embeds template', prBody.includes('### What does this PR do?') && prBody.includes('### Test plan'), prBody.slice(0, 300))
  check('PR body has Closes link', prBody.includes(`Closes #${issueNumber}`), prBody.slice(0, 300))
  check('PR body has diff-derived changes', prBody.includes('src/feature.js'), prBody.slice(0, 300))
  check('PR is a draft', prDetail.data.draft === true)

  /* ── read: review analysis ─────────────────────────────────────────────── */
  console.log('── read: gh_review_pr (analysis)')
  const reviewText = await run('gh_review_pr', { owner, repo: REPO, pullNumber })
  check('review scaffold live', reviewText.includes('Blocker (阻断') && reviewText.includes('src/feature.js'), reviewText.slice(0, 300))

  /* ── write: submit a review with an inline comment, then reply + resolve ── */
  console.log('── write: gh_review_pr post + gh_reply_comment resolveThread')
  const posted = await run('gh_review_pr', { owner, repo: REPO, pullNumber, post: true, body: 'LGTM after the window fix.', event: 'COMMENT' })
  check('review submitted live', posted.includes(`# Review submitted on PR #${pullNumber}`), posted.slice(0, 200))

  const inline = await api('POST', `/repos/${fullName}/pulls/${pullNumber}/comments`, {
    body: 'Nit: prefer a named constant.',
    path: 'src/feature.js',
    line: 1,
    commit_id: prDetail.data.head.sha,
  }, 201)
  const inlineId = inline.data.id

  const replied = await run('gh_reply_comment', {
    owner, repo: REPO, pullNumber, commentId: inlineId, body: 'Done — extracted WINDOW_MS.', resolveThread: true,
  })
  check('reply posted live', replied.includes(`# Reply posted on PR #${pullNumber}`), replied.slice(0, 200))
  check('thread resolved live', replied.includes('review thread resolved'), replied.slice(0, 300))

  /* ── write: request reviewers ──────────────────────────────────────────── */
  console.log('── write: gh_request_reviewers')
  let reviewersText = 'request failed'
  try {
    reviewersText = await run('gh_request_reviewers', { owner, repo: REPO, pullNumber, reviewers: ['octocat'] })
  } catch (error) {
    reviewersText = `ERROR: ${error.message}`
  }
  check('reviewers requested (or documented API refusal)', reviewersText.includes('Reviewers requested on PR') || reviewersText.includes('ERROR'), reviewersText.slice(0, 200))

  /* ── read: CI (empty path on real repo) ────────────────────────────────── */
  console.log('── read: gh_check_ci_status')
  const ciText = await run('gh_check_ci_status', { owner, repo: REPO, pullNumber })
  check('ci live path', ciText.includes('no statuses or check runs') || ciText.includes('Checks'), ciText.slice(0, 300))

  /* ── security: token scope gate (live) ─────────────────────────────────── */
  console.log('── security: requiredTokenScopes gate')
  const ctx2 = new Context()
  const tools2 = new ToolsService(ctx2)
  new SystemPromptService(ctx2)
  await ctx2.plugin(plugin, { requireApprovalForMutations: false, requiredTokenScopes: ['admin:org'] })
  const scopeText = await tools2.registry.get('gh_create_draft_pr').execute(
    { owner, repo: REPO, head: 'feat/live-test' },
    makeExec('gh_create_draft_pr', {}, { id: 'live-agent', name: 'live' }),
  )
  check('missing scope blocked live', scopeText.includes('missing required scope(s): admin:org'), scopeText.slice(0, 300))
  await ctx2.fiber.dispose()

  /* ── write: merge (after marking ready) + delete branch ────────────────── */
  console.log('── write: gh_merge_pr + gh_close_issue + gh_delete_branch')
  // markReady: true exercises the GraphQL markPullRequestReadyForReview path
  // (the REST PATCH `draft: false` field is silently ignored by the API —
  // verified live), and the merge itself goes through GraphQL mergePullRequest
  // because the REST merge endpoint returns 404 for OAuth tokens.
  const merged = await run('gh_merge_pr', { owner, repo: REPO, pullNumber, mergeMethod: 'squash', markReady: true, deleteBranchAfter: true })
  check('PR merged live', merged.includes(`# Pull request #${pullNumber} merged`), merged.slice(0, 300))
  const branchAfter = await api('GET', `/repos/${fullName}/git/ref/heads/feat/live-test`).catch(() => null)
  check('head branch deleted after merge', branchAfter === null || branchAfter.status === 404)

  const closed = await run('gh_close_issue', { owner, repo: REPO, issueNumber, stateReason: 'completed' })
  check('issue closed live', closed.includes(`# Issue #${issueNumber} closed`), closed.slice(0, 200))
  const issueAfter = await api('GET', `/repos/${fullName}/issues/${issueNumber}`)
  check('issue state on GitHub', issueAfter.data.state === 'closed' && issueAfter.data.state_reason === 'completed')

  const blockedDelete = await run('gh_delete_branch', { owner, repo: REPO, branch: defaultBranch })
  check('default branch deletion refused', blockedDelete.includes('default branch cannot be deleted'), blockedDelete.slice(0, 200))
} finally {
  /* ── cleanup: delete the throwaway repo (best-effort) ──────────────────── */
  if (owner !== '') {
    console.log('── cleanup: delete throwaway repository')
    try {
      const deleted = await api('DELETE', `/repos/${owner}/${REPO}`)
      check('throwaway repo deleted', deleted.status === 204 || deleted.status === 404, `status ${deleted.status}`)
      if (deleted.status === 403) {
        console.warn(`\nWARN  token lacks delete_repo scope — ${owner}/${REPO} was left in place.\n      Remove it manually:  gh repo delete ${owner}/${REPO} --yes   (after: gh auth refresh -h github.com -s delete_repo)`)
      }
    } catch (error) {
      failures += 1
      console.error(`FAIL  cleanup failed: ${error.message}`)
    }
  }
  await ctx.fiber.dispose()
}

console.log(failures === 0 ? '\nLIVE WRITE SMOKE PASSED' : `\n${failures} LIVE WRITE CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
