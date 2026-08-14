/**
 * Smoke test for dsh-github-workflow (temporary validation script).
 *
 * Mounts the built plugin into a real cordis Context with stub `tools` /
 * `systemPrompt` services, and exercises tool executions against a stubbed
 * global fetch. Run: node smoke.mjs
 */

import { Context, Service } from '@deepseek-ai/cordis'
import { rmSync } from 'node:fs'
import * as plugin from './lib/index.js'

// Mutation scenarios need a resolvable token (credentials seam absent →
// process-environment fallback).
process.env.GITHUB_TOKEN = 'ghp_smoke_test_token'

/* ── stub registries ─────────────────────────────────────────────────────── */

class ToolsService extends Service {
  constructor(ctx) {
    super(ctx, 'tools')
    this.registry = new Map()
  }
  register(def) {
    if (this.registry.has(def.name)) throw new Error(`duplicate tool ${def.name}`)
    this.registry.set(def.name, def)
  }
}

class SystemPromptService extends Service {
  constructor(ctx) {
    super(ctx, 'systemPrompt')
    this.sections = []
  }
  section(section) {
    this.sections.push(section)
  }
}

/* ── stub fetch ──────────────────────────────────────────────────────────── */

const requestLog = []

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json', ...extraHeaders },
  })
}

function makeFetch(handlers) {
  return async (url, init = {}) => {
    const u = new URL(url)
    const method = init.method ?? 'GET'
    const accept = init.headers?.accept ?? ''
    requestLog.push({ method, path: u.pathname, search: u.search, accept, body: init.body ?? null })
    for (const [pattern, handler] of handlers) {
      if (typeof pattern === 'string' ? u.pathname === pattern : pattern.test(u.pathname)) {
        return handler(u, method, accept, init.body ?? null)
      }
    }
    return json({ message: `stub 404: ${method} ${u.pathname}` }, 404)
  }
}

function withAuthHeader(resp) {
  return resp
}

/* ── helpers ─────────────────────────────────────────────────────────────── */

const ISSUE = {
  number: 42,
  title: 'Rate limit resets too early',
  state: 'open',
  body: '## Problem\nWhen the proxy exceeds 5000 requests, the window resets unexpectedly.\n\n- Must reset after 60 minutes\n- Must not affect authenticated users\n\nSee `rateLimiter` in src/core.',
  user: { login: 'alice' },
  labels: [{ name: 'bug' }, { name: 'good-first-issue' }],
  milestone: null,
  created_at: '2026-08-01T10:00:00Z',
  updated_at: '2026-08-10T09:00:00Z',
  comments: 2,
  html_url: 'https://github.com/o/r/issues/42',
}

const COMMENTS = [
  { id: 1, user: { login: 'bob' }, body: 'Reproduced on v2.1.\nWindow resets at 3600s not 3600 requests.', created_at: '2026-08-02T10:00:00Z', html_url: 'https://github.com/o/r/issues/42#issuecomment-1' },
]

const REPO = {
  full_name: 'o/r',
  description: 'A test repo',
  default_branch: 'main',
  language: 'TypeScript',
  stargazers_count: 12,
  forks_count: 3,
  open_issues_count: 5,
  archived: false,
  topics: ['api'],
  html_url: 'https://github.com/o/r',
}

const COMMITS = [
  { sha: 'abc1234def5678', commit: { message: 'fix(rate-limit): reset window after 60 minutes\n\nCloses #42', author: { date: '2026-08-11T08:00:00Z' } }, author: { login: 'alice' } },
]

const COMPARE = {
  status: 'ahead',
  ahead_by: 1,
  behind_by: 0,
  commits: COMMITS,
  files: [
    { filename: 'src/rate-limit.ts', status: 'modified', additions: 12, deletions: 3, changes: 15, raw_url: 'https://github.com/o/r/blob/main/src/rate-limit.ts' },
  ],
}

const PR = {
  number: 7,
  title: 'fix(rate-limit): reset window after 60 minutes',
  state: 'open',
  draft: false,
  body: 'Fixes #42',
  html_url: 'https://github.com/o/r/pull/7',
  user: { login: 'alice' },
  head: { ref: 'fix/rate-limit', sha: 'abc1234def5678', repo: { full_name: 'o/r' } },
  base: { ref: 'main', sha: 'f00d1234' },
  created_at: '2026-08-11T09:00:00Z',
  updated_at: '2026-08-11T09:30:00Z',
  merged_at: null,
  additions: 12,
  deletions: 3,
  changed_files: 1,
  mergeable: true,
  mergeable_state: 'clean',
}

const REVIEW_COMMENT = {
  id: 501,
  body: 'windowMs should use a named constant.',
  path: 'src/rate-limit.ts',
  line: 12,
  user: { login: 'bob' },
  created_at: '2026-08-11T09:05:00Z',
  in_reply_to_id: null,
  html_url: 'https://github.com/o/r/pull/7#discussion_r501',
}

const DIFF = `diff --git a/src/rate-limit.ts b/src/rate-limit.ts
index 1111111..2222222 100644
--- a/src/rate-limit.ts
+++ b/src/rate-limit.ts
@@ -10,7 +10,7 @@ export class RateLimiter {
-    const windowMs = 3600 * 1000;
+    const windowMs = 60 * 60 * 1000;
`

const FILES = [
  { filename: 'src/rate-limit.ts', status: 'modified', additions: 12, deletions: 3, changes: 15, raw_url: 'https://github.com/o/r/blob/main/src/rate-limit.ts' },
]

const STATUS = {
  state: 'failure',
  total_count: 1,
  statuses: [
    { context: 'ci/build', state: 'success', target_url: 'https://ci.example.com/1', description: null, created_at: '2026-08-11T09:00:00Z' },
  ],
}

const CHECK_RUNS = {
  total_count: 2,
  check_runs: [
    { id: 1, name: 'ci/build', status: 'completed', conclusion: 'success', details_url: 'https://ci.example.com/1', started_at: '2026-08-11T09:00:00Z', completed_at: '2026-08-11T09:01:00Z' },
    { id: 2, name: 'ci/lint', status: 'completed', conclusion: 'failure', details_url: 'https://ci.example.com/2', started_at: '2026-08-11T09:00:00Z', completed_at: '2026-08-11T09:01:00Z' },
  ],
}

function buildHandlers(overrides = {}) {
  const pr = overrides.pr ?? PR
  const issue = overrides.issue ?? ISSUE
  const openPulls = overrides.openPulls ?? []
  const templates = overrides.templates ?? {}
  const escaped = path => path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return [
    ...Object.entries(templates).map(([path, text]) => [
      new RegExp(`/repos/o/r/contents/${escaped(path)}$`),
      () => new Response(text, { status: 200, headers: { 'content-type': 'text/plain' } }),
    ]),
    [/\/repos\/o\/r\/pulls\/7\/merge$/, () => json({ sha: 'deadbeef1234', merged: true, message: 'Pull Request successfully merged' })],
    [/\/repos\/o\/r\/pulls\/7\/requested_reviewers$/, () => json({ reviewers: [{ login: 'carol' }], teams: [] })],
    [/\/repos\/o\/r\/pulls\/7\/comments$/, (u, method) => {
      if (method === 'POST') {
        return json({ ...REVIEW_COMMENT, id: 502, in_reply_to_id: 501, body: 'Done.', html_url: 'https://github.com/o/r/pull/7#discussion_r502' }, 201)
      }
      return json([REVIEW_COMMENT])
    }],
    [/\/repos\/o\/r\/issues\/42\/comments$/, (u, method) => {
      if (method === 'POST') {
        return json({ id: 900, body: 'Agreed.', user: { login: 'alice' }, created_at: '2026-08-11T10:00:00Z', html_url: 'https://github.com/o/r/issues/42#issuecomment-900' }, 201)
      }
      return json(COMMENTS)
    }],
    [/\/repos\/o\/r\/issues\/42$/, (u, method) => {
      if (method === 'PATCH') {
        return json({ ...issue, state: 'closed', state_reason: 'completed' })
      }
      return json(issue)
    }],
    [/\/repos\/o\/r\/git\/refs\/heads\//, () => new Response(null, { status: 204 })],
    [/\/repos\/o\/r\/branches\/main\/protection$/, () => json({
      required_pull_request_reviews: { required_approving_review_count: 1, dismiss_stale_reviews: true },
      required_status_checks: { contexts: ['ci/build'], strict: true },
      enforce_admins: { enabled: false },
      required_linear_history: { enabled: true },
      restrictions: null,
    })],
    [/\/repos\/o\/r\/contents\/\.github\/CODEOWNERS$/, () => new Response(
      '# owners\n/src/ @alice @bob\n/docs/ @carol\n',
      { status: 200, headers: { 'content-type': 'text/plain' } },
    )],
    [/\/repos\/o\/r\/check-runs\/2\/annotations$/, () => json([
      { path: 'src/rate-limit.ts', start_line: 12, end_line: 12, message: 'windowMs should use a named constant', annotation_level: 'warning' },
    ])],
    [/\/graphql$/, (u, method, accept, body) => {
      const query = body ? (JSON.parse(body).query ?? '') : ''
      if (query.includes('resolveReviewThread')) {
        return json({ data: { resolveReviewThread: { thread: { id: 't-7001', isResolved: true } } } })
      }
      if (query.includes('markPullRequestReadyForReview')) {
        return json({ data: { markPullRequestReadyForReview: { pullRequest: { isDraft: false } } } })
      }
      if (query.includes('mergePullRequest')) {
        return json({ data: { mergePullRequest: { pullRequest: { mergedAt: '2026-08-11T10:00:00Z', mergeCommit: { oid: 'deadbeef1234' } } } } })
      }
      if (query.includes('databaseId')) {
        return json({ data: { repository: { id: 'repo-1', pullRequest: { id: 'pr-1', reviewThreads: { nodes: [{ id: 't-7001', databaseId: 7001, comments: { nodes: [{ databaseId: 501 }] } }] } } } } })
      }
      return json({
        data: {
          repository: {
            pullRequest: {
              id: 'pr-1',
              reviewThreads: {
                nodes: [{
                  isResolved: false,
                  path: 'src/rate-limit.ts',
                  line: 12,
                  comments: { nodes: [{ author: { login: 'bob' }, body: 'windowMs should use a named constant.', createdAt: '2026-08-11T09:05:00Z' }] },
                }],
              },
            },
          },
        },
      })
    }],
    [/\/repos\/o\/r\/issues\/42$/, () => json(ISSUE)],
    [/\/repos\/o\/r\/branches\//, () => json({ name: 'fix/rate-limit' })],
    [/\/repos\/o\/r\/compare\//, () => json(COMPARE)],
    [/\/repos\/o\/r\/pulls\/7\/files$/, () => json(FILES)],
    [/\/repos\/o\/r\/pulls\/7$/, (u, method, accept) =>
      accept.includes('diff') ? new Response(DIFF, { status: 200 }) : json(pr)],
    [/\/repos\/o\/r\/pulls$/, (u, method) => {
      if (method === 'POST') {
        return json({ number: 88, html_url: 'https://github.com/o/r/pull/88', title: 't', draft: true, head: { ref: 'x' }, base: { ref: 'main' } }, 201)
      }
      return json(openPulls)
    }],
    [/\/repos\/o\/r\/pulls\/7\/reviews$/, () => json({ id: 1, html_url: 'https://github.com/o/r/pull/7#pullrequestreview-1', state: 'COMMENTED', body: 'b', submitted_at: '2026-08-11T10:00:00Z', user: { login: 'alice' } }, 200)],
    [/\/repos\/o\/r\/commits\/[^/]+\/check-runs$/, () => json(CHECK_RUNS)],
    [/\/repos\/o\/r\/commits\/[^/]+\/status$/, () => json(STATUS)],
    [/\/repos\/o\/r\/commits\/[^/]+$/, (u) => {
      const ref = decodeURIComponent(u.pathname.split('/').pop())
      return json({
        ...COMMITS[0],
        commit: { ...COMMITS[0].commit, author: { date: ref === 'v1.0' ? '2026-07-20T00:00:00Z' : '2026-08-11T08:00:00Z' } },
      })
    }],
    [/\/repos\/o\/r\/commits$/, () => json(COMMITS)],
    [/\/repos\/o\/r$/, () => json(REPO)],
    [/\/search\/issues$/, (u) => {
      const q = u.searchParams.get('q') ?? ''
      if (q.includes('is:merged')) {
        return json({ total_count: 2, items: [
          { number: 44, title: 'feat: token refresh', state: 'closed', html_url: 'https://github.com/o/r/pull/44', created_at: '2026-07-28T00:00:00Z', updated_at: '2026-07-29T00:00:00Z', comments: 2, user: { login: 'alice' }, labels: [{ name: 'enhancement' }], pull_request: { merged_at: '2026-07-30T10:00:00Z' } },
          { number: 43, title: 'fix: retry backoff', state: 'closed', html_url: 'https://github.com/o/r/pull/43', created_at: '2026-07-25T00:00:00Z', updated_at: '2026-07-26T00:00:00Z', comments: 1, user: { login: 'bob' }, labels: [{ name: 'bug' }], pull_request: { merged_at: '2026-07-27T09:00:00Z' } },
        ] })
      }
      if (q.includes('is:pr') && q.includes('#42')) {
        return json({ total_count: 1, items: [{ number: 45, title: 'fix: rate limit window', state: 'open', html_url: 'https://github.com/o/r/pull/45', created_at: '2026-08-05T00:00:00Z', updated_at: '2026-08-06T00:00:00Z', comments: 1, user: { login: 'carol' }, labels: [], pull_request: { merged_at: null } }] })
      }
      if (q.includes('is:pr')) {
        return json({ total_count: 1, items: [{ number: 46, title: 'refactor: rate limiter internals', state: 'closed', html_url: 'https://github.com/o/r/pull/46', created_at: '2026-07-01T00:00:00Z', updated_at: '2026-07-02T00:00:00Z', comments: 0, user: { login: 'dave' }, labels: [], pull_request: { merged_at: '2026-07-03T00:00:00Z' } }] })
      }
      if (q.includes('is:issue')) {
        return json({ total_count: 1, items: [{ number: 99, title: 'Rate limit window too short', state: 'open', html_url: 'https://github.com/o/r/issues/99', created_at: '2026-07-20T00:00:00Z', updated_at: '2026-07-21T00:00:00Z', comments: 3, user: { login: 'eve' }, labels: [{ name: 'bug' }] }] })
      }
      return json({ total_count: 0, items: [] })
    }],
  ]
}

/* ── scenario runner ─────────────────────────────────────────────────────── */

let failures = 0
function check(name, condition, detail = '') {
  if (condition) {
    console.log(`  ok  ${name}`)
  } else {
    failures += 1
    console.log(`FAIL  ${name}${detail ? `\n      ${detail}` : ''}`)
  }
}

function makeExec(name, args, agent = undefined) {
  return {
    name,
    callId: `smoke-${name}`,
    rootCallId: `smoke-${name}`,
    arguments: args,
    agent,
    token: Symbol('smoke'),
    signal: new AbortController().signal,
  }
}

const FAKE_AGENT = { id: 'sess-1', name: 'smoke' }

class FakeSession {
  constructor(id) {
    this.id = id
    this.events = []
  }
  append(type, data) {
    this.events.push({ type, data })
  }
}

class FakeSessionsStore extends Service {
  constructor(ctx) {
    super(ctx, 'sessions')
    this.sessions = new Map()
  }
  get(id) {
    return this.sessions.get(id)
  }
  add(session) {
    this.sessions.set(session.id, session)
  }
}

async function scenario(name, config, fn) {
  console.log(`\n── ${name}`)
  const ctx = new Context()
  const tools = new ToolsService(ctx)
  const prompt = new SystemPromptService(ctx)
  const sessions = new FakeSessionsStore(ctx)
  sessions.add(new FakeSession('sess-1'))
  await ctx.plugin(plugin, config)
  requestLog.length = 0
  const result = await fn(ctx, tools, prompt, sessions)
  await ctx.fiber.dispose()
  return result
}

/* 1. registration */
await scenario('registration', undefined, (_ctx, tools, prompt) => {
  const names = [...tools.registry.keys()].sort()
  check('twelve tools registered', names.length === 12, names.join(', '))
  check(
    'tool names',
    JSON.stringify(names) === JSON.stringify([
      'gh_analyze_issue', 'gh_check_ci_status', 'gh_close_issue', 'gh_create_draft_pr',
      'gh_delete_branch', 'gh_generate_release_notes', 'gh_get_repo_context', 'gh_merge_pr',
      'gh_reply_comment', 'gh_request_reviewers', 'gh_review_pr', 'gh_search_related',
    ]),
    names.join(', '),
  )
  check('prompt section added', prompt.sections.length === 1 && prompt.sections[0].name === 'tool:github-workflow')
})

/* 2. analyze_issue (read path) */
await scenario('gh_analyze_issue', undefined, async (ctx, tools) => {
  globalThis.fetch = makeFetch(buildHandlers())
  const def = tools.registry.get('gh_analyze_issue')
  const text = await def.execute({ owner: 'o', repo: 'r', issueNumber: 42 }, makeExec('gh_analyze_issue', {}))
  check('renders title', text.includes('# Issue #42 — Rate limit resets too early'))
  check('renders analysis scaffold', text.includes('Problem understanding') && text.includes('Impact scope') && text.includes('Implementation suggestions') && text.includes('Potential risks'))
  check('extracts candidate requirements', text.includes('Must reset after 60 minutes'))
  check('renders comments', text.includes('Reproduced on v2.1'))
  check('finds linked PR via search', text.includes('#45'))
  check('finds historical PR via keywords', text.includes('#46') && text.includes('Historical pull requests'))
  check('finds similar issues', text.includes('#99') && text.includes('Similar issues'))
  check('extracts issue refs', text.includes('Closes') || text.includes('#42'))
})

/* 3. create_draft_pr denied (no approval service, default gate on) */
await scenario('gh_create_draft_pr denied by approval gate', undefined, async (ctx, tools) => {
  globalThis.fetch = makeFetch(buildHandlers())
  const def = tools.registry.get('gh_create_draft_pr')
  const text = await def.execute(
    { owner: 'o', repo: 'r', head: 'fix/rate-limit' },
    makeExec('gh_create_draft_pr', {}),
  )
  check('blocked with reason', text.includes('Mutation blocked') && text.includes('no approval service'), text.slice(0, 200))
  check('no POST sent', !requestLog.some(r => r.method === 'POST'))
})

/* 4. read-only mode */
await scenario('gh_create_draft_pr denied by read-only mode', { readOnly: true }, async (ctx, tools, _prompt, sessions) => {
  globalThis.fetch = makeFetch(buildHandlers())
  const def = tools.registry.get('gh_create_draft_pr')
  const text = await def.execute(
    { owner: 'o', repo: 'r', head: 'fix/rate-limit' },
    makeExec('gh_create_draft_pr', {}, FAKE_AGENT),
  )
  check('blocked with read-only reason', text.includes('read-only mode'), text.slice(0, 200))
  const traced = sessions.sessions.get('sess-1').events
  check('denial traced to session log',
    traced.length === 1 && traced[0].type === 'github-workflow/operation'
      && traced[0].data.outcome === 'denied' && traced[0].data.detail.includes('read-only'),
    JSON.stringify(traced))
})

/* 5. create_draft_pr allowed, diff-derived description */
await scenario('gh_create_draft_pr allowed (gate off)', { requireApprovalForMutations: false }, async (ctx, tools, _prompt, sessions) => {
  globalThis.fetch = makeFetch(buildHandlers())
  const def = tools.registry.get('gh_create_draft_pr')
  const text = await def.execute(
    { owner: 'o', repo: 'r', head: 'fix/rate-limit' },
    makeExec('gh_create_draft_pr', {}, FAKE_AGENT),
  )
  check('PR created', text.includes('# Draft pull request #88 created'), text.slice(0, 120))
  check('POST sent to /pulls', requestLog.some(r => r.method === 'POST' && r.path === '/repos/o/r/pulls'))
  const post = requestLog.find(r => r.method === 'POST' && r.path === '/repos/o/r/pulls')
  const body = post ? JSON.parse(post.body) : null
  check('body is diff-derived', body && body.body.includes('## Summary') && body.body.includes('src/rate-limit.ts'))
  check('draft flag set', body && body.draft === true)
  check('title from commit message', body && body.title === 'fix(rate-limit): reset window after 60 minutes', body?.title)
  const traced = sessions.sessions.get('sess-1').events
  check('success traced to session log',
    traced.length === 1 && traced[0].type === 'github-workflow/operation'
      && traced[0].data.outcome === 'success' && traced[0].data.number === 88 && traced[0].data.url === 'https://github.com/o/r/pull/88',
    JSON.stringify(traced))
})

/* 6. review_pr analyze + post */
await scenario('gh_review_pr', { requireApprovalForMutations: false }, async (ctx, tools, _prompt, sessions) => {
  globalThis.fetch = makeFetch(buildHandlers())
  const def = tools.registry.get('gh_review_pr')
  const analysis = await def.execute(
    { owner: 'o', repo: 'r', pullNumber: 7 },
    makeExec('gh_review_pr', {}, FAKE_AGENT),
  )
  check('severity scaffold (blocker/suggestion/polish)',
    analysis.includes('Blocker (阻断') && analysis.includes('Suggestion (建议') && analysis.includes('Polish (优化'), analysis.slice(0, 300))
  check('diff embedded', analysis.includes('diff --git a/src/rate-limit.ts'))
  check('files table', analysis.includes('src/rate-limit.ts'))
  check('existing review comments listed', analysis.includes('Existing review comments') && analysis.includes('#501'))
  check('review threads via GraphQL', analysis.includes('Review threads (threaded view, GraphQL)') && analysis.includes('@bob'))

  const posted = await def.execute(
    { owner: 'o', repo: 'r', pullNumber: 7, post: true, body: 'LGTM after the window fix.', event: 'COMMENT' },
    makeExec('gh_review_pr', {}, FAKE_AGENT),
  )
  check('review submitted', posted.includes('# Review submitted on PR #7'), posted.slice(0, 160))
  const reviewPost = requestLog.find(r => r.method === 'POST' && r.path === '/repos/o/r/pulls/7/reviews')
  check('review POST has body+event', reviewPost && JSON.parse(reviewPost.body).body === 'LGTM after the window fix.')
  const traced = sessions.sessions.get('sess-1').events
  check('review submission traced to session log',
    traced.length === 1 && traced[0].data.operation === 'submit_review' && traced[0].data.outcome === 'success',
    JSON.stringify(traced))
})

/* 7. check_ci_status */
await scenario('gh_check_ci_status', undefined, async (ctx, tools) => {
  globalThis.fetch = makeFetch(buildHandlers())
  const def = tools.registry.get('gh_check_ci_status')
  const text = await def.execute(
    { owner: 'o', repo: 'r', pullNumber: 7 },
    makeExec('gh_check_ci_status', {}),
  )
  check('combined status shown', text.includes('combined status: failure'), text.slice(0, 200))
  check('check runs listed', text.includes('ci/lint') && text.includes('ci/build'))
  check('failing listed', text.includes('1 failing') && text.includes('ci/lint'))
  check('annotations for failing run', text.includes('Annotations for ci/lint') && text.includes('windowMs should use a named constant'), text.slice(0, 600))
})

/* 8. search_related */
await scenario('gh_search_related', undefined, async (ctx, tools) => {
  globalThis.fetch = makeFetch(buildHandlers())
  const def = tools.registry.get('gh_search_related')
  const text = await def.execute(
    { query: 'rate limit', owner: 'o', repo: 'r', type: 'pull' },
    makeExec('gh_search_related', {}),
  )
  check('search results', text.includes('#46') && text.includes('[pr merged]'), text.slice(0, 200))
})

/* 9. approval service gates mutations */
class FakeApprovalService extends Service {
  constructor(ctx, outcome) {
    super(ctx, 'approval')
    this.outcome = outcome
    this.lastRequest = null
  }
  async request(req) {
    this.lastRequest = req
    return this.outcome
  }
}

{
  console.log('\n── gh_create_draft_pr allowed via approval service (gate on)')
  const ctx = new Context()
  const tools = new ToolsService(ctx)
  new SystemPromptService(ctx)
  const approval = new FakeApprovalService(ctx, 'allowed-once')
  await ctx.plugin(plugin, undefined)
  globalThis.fetch = makeFetch(buildHandlers())
  const def = tools.registry.get('gh_create_draft_pr')
  const text = await def.execute(
    { owner: 'o', repo: 'r', head: 'fix/rate-limit' },
    makeExec('gh_create_draft_pr', {}, FAKE_AGENT),
  )
  check('PR created after approval', text.includes('# Draft pull request #88 created'), text.slice(0, 160))
  check('approval request carried tool name + reason',
    approval.lastRequest?.toolName === 'gh_create_draft_pr' && approval.lastRequest?.reason.includes('create draft'),
    JSON.stringify(approval.lastRequest))
  await ctx.fiber.dispose()
}

{
  console.log('\n── gh_create_draft_pr rejected by approval service')
  const ctx = new Context()
  const tools = new ToolsService(ctx)
  new SystemPromptService(ctx)
  const approval = new FakeApprovalService(ctx, 'rejected')
  await ctx.plugin(plugin, undefined)
  requestLog.length = 0
  globalThis.fetch = makeFetch(buildHandlers())
  const def = tools.registry.get('gh_create_draft_pr')
  const text = await def.execute(
    { owner: 'o', repo: 'r', head: 'fix/rate-limit' },
    makeExec('gh_create_draft_pr', {}, FAKE_AGENT),
  )
  check('blocked after rejection', text.includes('Mutation blocked') && text.includes('not approved'), text.slice(0, 200))
  check('no POST sent', !requestLog.some(r => r.method === 'POST' && r.path === '/repos/o/r/pulls'))
  await ctx.fiber.dispose()
}

/* 10. token scope verification */
{
  console.log('\n── token scopes: missing scope blocks the mutation')
  const handlers = buildHandlers()
  handlers.unshift([/\/user$/, () => json({ login: 'alice' }, 200, { 'x-oauth-scopes': 'repo' })])
  const ctx = new Context()
  const tools = new ToolsService(ctx)
  new SystemPromptService(ctx)
  await ctx.plugin(plugin, { requireApprovalForMutations: false, requiredTokenScopes: ['repo', 'workflow'] })
  requestLog.length = 0
  globalThis.fetch = makeFetch(handlers)
  const def = tools.registry.get('gh_create_draft_pr')
  const text = await def.execute(
    { owner: 'o', repo: 'r', head: 'fix/rate-limit' },
    makeExec('gh_create_draft_pr', {}),
  )
  check('denied with missing scope', text.includes('missing required scope(s): workflow'), text.slice(0, 300))
  check('no POST sent', !requestLog.some(r => r.method === 'POST' && r.path === '/repos/o/r/pulls'))
  await ctx.fiber.dispose()
}

{
  console.log('\n── token scopes: sufficient scopes allow the mutation')
  const handlers = buildHandlers()
  handlers.unshift([/\/user$/, () => json({ login: 'alice' }, 200, { 'x-oauth-scopes': 'repo, workflow' })])
  const ctx = new Context()
  const tools = new ToolsService(ctx)
  new SystemPromptService(ctx)
  await ctx.plugin(plugin, { requireApprovalForMutations: false, requiredTokenScopes: ['repo', 'workflow'] })
  globalThis.fetch = makeFetch(handlers)
  const def = tools.registry.get('gh_create_draft_pr')
  const text = await def.execute(
    { owner: 'o', repo: 'r', head: 'fix/rate-limit' },
    makeExec('gh_create_draft_pr', {}),
  )
  check('PR created with sufficient scopes', text.includes('# Draft pull request #88 created'), text.slice(0, 160))
  await ctx.fiber.dispose()
}

{
  console.log('\n── gh_merge_pr: success with head-branch deletion (GraphQL merge)')
  const ctx = new Context()
  const tools = new ToolsService(ctx)
  new SystemPromptService(ctx)
  await ctx.plugin(plugin, { requireApprovalForMutations: false })
  requestLog.length = 0
  globalThis.fetch = makeFetch(buildHandlers())
  const mergeDef = tools.registry.get('gh_merge_pr')
  const text = await mergeDef.execute(
    { owner: 'o', repo: 'r', pullNumber: 7, mergeMethod: 'squash', deleteBranchAfter: true },
    makeExec('gh_merge_pr', {}, FAKE_AGENT),
  )
  check('merged with sha', text.includes('# Pull request #7 merged') && text.includes('deadbeef1234'), text.slice(0, 200))
  const mergeGql = requestLog.find(r =>
    r.path === '/graphql' && typeof r.body === 'string' && r.body.includes('mergePullRequest'))
  check('merge via GraphQL with SQUASH', mergeGql !== undefined && mergeGql.body.includes('SQUASH'))
  check('head branch deleted', requestLog.some(r =>
    r.method === 'DELETE' && r.path === `/repos/o/r/git/refs/heads/${encodeURIComponent('fix/rate-limit')}`))
  await ctx.fiber.dispose()
}

{
  console.log('\n── gh_merge_pr: draft refusal without markReady')
  const ctx = new Context()
  const tools = new ToolsService(ctx)
  new SystemPromptService(ctx)
  await ctx.plugin(plugin, { requireApprovalForMutations: false })
  requestLog.length = 0
  globalThis.fetch = makeFetch(buildHandlers({ pr: { ...PR, draft: true, mergeable_state: 'draft' } }))
  const def = tools.registry.get('gh_merge_pr')
  const text = await def.execute(
    { owner: 'o', repo: 'r', pullNumber: 7 },
    makeExec('gh_merge_pr', {}, FAKE_AGENT),
  )
  check('draft refused', text.includes('Draft pull requests cannot be merged'), text.slice(0, 200))
  check('no merge request', !requestLog.some(r => r.path === '/graphql' && typeof r.body === 'string' && r.body.includes('mergePullRequest')))
  await ctx.fiber.dispose()
}

{
  console.log('\n── gh_merge_pr: draft merged with markReady')
  const ctx = new Context()
  const tools = new ToolsService(ctx)
  new SystemPromptService(ctx)
  await ctx.plugin(plugin, { requireApprovalForMutations: false })
  requestLog.length = 0
  globalThis.fetch = makeFetch(buildHandlers({ pr: { ...PR, draft: true, mergeable_state: 'draft' } }))
  const def = tools.registry.get('gh_merge_pr')
  const text = await def.execute(
    { owner: 'o', repo: 'r', pullNumber: 7, markReady: true },
    makeExec('gh_merge_pr', {}, FAKE_AGENT),
  )
  check('draft merged after markReady', text.includes('# Pull request #7 merged'), text.slice(0, 200))
  check('markPullRequestReadyForReview sent', requestLog.some(r =>
    r.path === '/graphql' && typeof r.body === 'string' && r.body.includes('markPullRequestReadyForReview')))
  await ctx.fiber.dispose()
}

{
  console.log('\n── gh_close_issue')
  const ctx = new Context()
  const tools = new ToolsService(ctx)
  new SystemPromptService(ctx)
  await ctx.plugin(plugin, { requireApprovalForMutations: false })
  requestLog.length = 0
  globalThis.fetch = makeFetch(buildHandlers())
  const def = tools.registry.get('gh_close_issue')
  const text = await def.execute(
    { owner: 'o', repo: 'r', issueNumber: 42, stateReason: 'completed' },
    makeExec('gh_close_issue', {}, FAKE_AGENT),
  )
  check('issue closed', text.includes('# Issue #42 closed') && text.includes('state reason: completed'), text.slice(0, 200))
  const patch = requestLog.find(r => r.method === 'PATCH' && r.path === '/repos/o/r/issues/42')
  check('PATCH sent', patch && JSON.parse(patch.body).state === 'closed')
  await ctx.fiber.dispose()
}

{
  console.log('\n── gh_delete_branch: safety refusals and success')
  const ctx = new Context()
  const tools = new ToolsService(ctx)
  new SystemPromptService(ctx)
  await ctx.plugin(plugin, { requireApprovalForMutations: false })
  requestLog.length = 0
  globalThis.fetch = makeFetch(buildHandlers({ openPulls: [PR] }))
  const def = tools.registry.get('gh_delete_branch')
  const defaultText = await def.execute(
    { owner: 'o', repo: 'r', branch: 'main' },
    makeExec('gh_delete_branch', {}, FAKE_AGENT),
  )
  check('default branch refused', defaultText.includes('default branch cannot be deleted'), defaultText.slice(0, 200))
  const openPrText = await def.execute(
    { owner: 'o', repo: 'r', branch: 'fix/rate-limit' },
    makeExec('gh_delete_branch', {}, FAKE_AGENT),
  )
  check('open-PR head refused', openPrText.includes('head of open pull request(s) #7'), openPrText.slice(0, 200))
  const okText = await def.execute(
    { owner: 'o', repo: 'r', branch: 'old/cleanup' },
    makeExec('gh_delete_branch', {}, FAKE_AGENT),
  )
  check('deleted', okText.includes('Branch "old/cleanup" deleted'), okText.slice(0, 200))
  check('DELETE sent', requestLog.some(r =>
    r.method === 'DELETE' && r.path === `/repos/o/r/git/refs/heads/${encodeURIComponent('old/cleanup')}`))
  await ctx.fiber.dispose()
}

{
  console.log('\n── gh_request_reviewers')
  const ctx = new Context()
  const tools = new ToolsService(ctx)
  new SystemPromptService(ctx)
  await ctx.plugin(plugin, { requireApprovalForMutations: false })
  requestLog.length = 0
  globalThis.fetch = makeFetch(buildHandlers())
  const def = tools.registry.get('gh_request_reviewers')
  const text = await def.execute(
    { owner: 'o', repo: 'r', pullNumber: 7, reviewers: ['carol'], teamReviewers: ['reviewers'] },
    makeExec('gh_request_reviewers', {}, FAKE_AGENT),
  )
  check('reviewers requested', text.includes('Reviewers requested on PR #7') && text.includes('@carol'), text.slice(0, 200))
  const post = requestLog.find(r => r.method === 'POST' && r.path === '/repos/o/r/pulls/7/requested_reviewers')
  check('POST with reviewers+teams', post && JSON.parse(post.body).reviewers[0] === 'carol' && JSON.parse(post.body).team_reviewers[0] === 'reviewers')
  await ctx.fiber.dispose()
}

{
  console.log('\n── gh_reply_comment: review and issue threads')
  const ctx = new Context()
  const tools = new ToolsService(ctx)
  new SystemPromptService(ctx)
  await ctx.plugin(plugin, { requireApprovalForMutations: false })
  requestLog.length = 0
  globalThis.fetch = makeFetch(buildHandlers())
  const def = tools.registry.get('gh_reply_comment')
  const reviewReply = await def.execute(
    { owner: 'o', repo: 'r', pullNumber: 7, commentId: 501, body: 'Done.', resolveThread: true },
    makeExec('gh_reply_comment', {}, FAKE_AGENT),
  )
  check('review reply posted', reviewReply.includes('# Reply posted on PR #7'), reviewReply.slice(0, 160))
  check('thread resolved via GraphQL', reviewReply.includes('review thread resolved'), reviewReply.slice(0, 300))
  const resolveMutation = requestLog.find(r =>
    r.path === '/graphql' && typeof r.body === 'string' && r.body.includes('resolveReviewThread'))
  check('resolve mutation sent', resolveMutation !== undefined)
  const reviewPost = requestLog.find(r => r.method === 'POST' && r.path === '/repos/o/r/pulls/7/comments')
  check('review reply in_reply_to', reviewPost && JSON.parse(reviewPost.body).in_reply_to === 501)
  const issueReply = await def.execute(
    { owner: 'o', repo: 'r', issueNumber: 42, commentId: 1, body: 'Agreed.' },
    makeExec('gh_reply_comment', {}, FAKE_AGENT),
  )
  check('issue reply posted', issueReply.includes('# Reply posted on issue #42'), issueReply.slice(0, 160))
  const issuePost = requestLog.find(r => r.method === 'POST' && r.path === '/repos/o/r/issues/42/comments')
  check('issue reply in_reply_to', issuePost && JSON.parse(issuePost.body).in_reply_to === 1)
  const ambiguous = await def.execute(
    { owner: 'o', repo: 'r', commentId: 1, body: 'x', pullNumber: 7, issueNumber: 42 },
    makeExec('gh_reply_comment', {}, FAKE_AGENT),
  )
  check('ambiguous target refused', ambiguous.includes('exactly one'), ambiguous.slice(0, 200))
  await ctx.fiber.dispose()
}

{
  console.log('\n── gh_get_repo_context: CODEOWNERS, protection, cache')
  const ctx = new Context()
  const tools = new ToolsService(ctx)
  new SystemPromptService(ctx)
  await ctx.plugin(plugin, undefined)
  requestLog.length = 0
  globalThis.fetch = makeFetch(buildHandlers())
  const def = tools.registry.get('gh_get_repo_context')
  const first = await def.execute(
    { owner: 'o', repo: 'r' },
    makeExec('gh_get_repo_context', {}, FAKE_AGENT),
  )
  check('CODEOWNERS rendered', first.includes('CODEOWNERS (.github/CODEOWNERS)') && first.includes('/src/ @alice @bob'), first.slice(0, 400))
  check('branch protection rendered', first.includes('required approvals: 1') && first.includes('ci/build'), first.slice(0, 400))
  const governanceBefore = requestLog.filter(r => r.path.includes('CODEOWNERS') || r.path.includes('protection')).length
  const second = await def.execute(
    { owner: 'o', repo: 'r' },
    makeExec('gh_get_repo_context', {}, FAKE_AGENT),
  )
  const governanceAfter = requestLog.filter(r => r.path.includes('CODEOWNERS') || r.path.includes('protection')).length
  check('governance cached on second call', governanceAfter === governanceBefore && second.includes('CODEOWNERS'), `before=${governanceBefore} after=${governanceAfter}`)
  await ctx.fiber.dispose()
}

{
  console.log('\n── gh_create_draft_pr: repository PR template awareness')
  const ctx = new Context()
  const tools = new ToolsService(ctx)
  new SystemPromptService(ctx)
  await ctx.plugin(plugin, { requireApprovalForMutations: false })
  requestLog.length = 0
  globalThis.fetch = makeFetch(buildHandlers({
    templates: { '.github/pull_request_template.md': '### What does this PR do?\n\n### Test plan\n- [ ] unit tests' },
  }))
  const def = tools.registry.get('gh_create_draft_pr')
  const text = await def.execute(
    { owner: 'o', repo: 'r', head: 'fix/rate-limit' },
    makeExec('gh_create_draft_pr', {}, FAKE_AGENT),
  )
  const post = requestLog.find(r => r.method === 'POST' && r.path === '/repos/o/r/pulls')
  const body = post ? JSON.parse(post.body).body : ''
  check('template text embedded', body.includes('### What does this PR do?') && body.includes('### Test plan'), body.slice(0, 300))
  check('derived sections kept after template', body.includes('## Changes') && body.includes('src/rate-limit.ts'))
  check('body source names template', text.includes('.github/pull_request_template.md'), text.slice(0, 300))
  await ctx.fiber.dispose()
}

{
  console.log('\n── gh_generate_release_notes')
  const ctx = new Context()
  const tools = new ToolsService(ctx)
  new SystemPromptService(ctx)
  await ctx.plugin(plugin, undefined)
  requestLog.length = 0
  globalThis.fetch = makeFetch(buildHandlers())
  const def = tools.registry.get('gh_generate_release_notes')
  const text = await def.execute(
    { owner: 'o', repo: 'r', from: 'v1.0' },
    makeExec('gh_generate_release_notes', {}, FAKE_AGENT),
  )
  check('release notes header', text.includes('# Release notes — o/r'), text.slice(0, 300))
  check('range rendered', text.includes('v1.0 → main') && text.includes('merged pull requests: 2'))
  check('merged PRs listed', text.includes('#44') && text.includes('#43') && text.includes('enhancement') && text.includes('bug'))
  check('chronological order', text.indexOf('#43') < text.indexOf('#44'), text.slice(0, 400))
  await ctx.fiber.dispose()
}

{
  console.log('\n── cache: file persistence + post-mutation invalidation')
  const cacheFile = './.smoke-cache.json'
  rmSync(cacheFile, { force: true })

  // First process-like run: fill the cache, persisted to the file.
  const ctx1 = new Context()
  const tools1 = new ToolsService(ctx1)
  new SystemPromptService(ctx1)
  await ctx1.plugin(plugin, { requireApprovalForMutations: false, contextCachePath: cacheFile })
  requestLog.length = 0
  globalThis.fetch = makeFetch(buildHandlers())
  const contextDef = tools1.registry.get('gh_get_repo_context')
  await contextDef.execute({ owner: 'o', repo: 'r' }, makeExec('gh_get_repo_context', {}, FAKE_AGENT))
  const governanceInFirstRun = requestLog.filter(r => r.path.includes('CODEOWNERS') || r.path.includes('protection')).length
  check('governance fetched in first run', governanceInFirstRun > 0)
  await ctx1.fiber.dispose()

  // Second process-like run: cache restored from the file.
  const ctx2 = new Context()
  const tools2 = new ToolsService(ctx2)
  new SystemPromptService(ctx2)
  await ctx2.plugin(plugin, { requireApprovalForMutations: false, contextCachePath: cacheFile })
  requestLog.length = 0
  globalThis.fetch = makeFetch(buildHandlers())
  const contextDef2 = tools2.registry.get('gh_get_repo_context')
  const restored = await contextDef2.execute({ owner: 'o', repo: 'r' }, makeExec('gh_get_repo_context', {}, FAKE_AGENT))
  const governanceInSecondRun = requestLog.filter(r => r.path.includes('CODEOWNERS') || r.path.includes('protection')).length
  check('governance loaded from persisted cache', governanceInSecondRun === 0 && restored.includes('CODEOWNERS'), `governance requests: ${governanceInSecondRun}`)

  // A mutation invalidates the repo's cached facts.
  const closeDef = tools2.registry.get('gh_close_issue')
  await closeDef.execute({ owner: 'o', repo: 'r', issueNumber: 42 }, makeExec('gh_close_issue', {}, FAKE_AGENT))
  await contextDef2.execute({ owner: 'o', repo: 'r' }, makeExec('gh_get_repo_context', {}, FAKE_AGENT))
  const governanceAfterInvalidation = requestLog.filter(r => r.path.includes('CODEOWNERS') || r.path.includes('protection')).length
  check('cached facts refetched after mutation', governanceAfterInvalidation > 0, `governance requests: ${governanceAfterInvalidation}`)

  await ctx2.fiber.dispose()
  rmSync(cacheFile, { force: true })
}

/* ── CJK keywords ────────────────────────────────────────────────────────── */
await scenario('gh_analyze_issue with CJK issue', undefined, async (ctx, tools) => {
  globalThis.fetch = makeFetch(buildHandlers({ issue: { ...ISSUE, title: '修复限流窗口重置', body: '窗口没有正确重置。' } }))
  const def = tools.registry.get('gh_analyze_issue')
  const text = await def.execute({ owner: 'o', repo: 'r', issueNumber: 42 }, makeExec('gh_analyze_issue', {}))
  check('CJK phrase keywords extracted', text.includes('Search keywords used: 修复限流窗口重置'), text.slice(-400))
  check('similar issues still found for CJK', text.includes('Similar issues') && text.includes('#99'))
  check('historical PRs still found for CJK', text.includes('Historical pull requests'))
})

/* ── pagination ──────────────────────────────────────────────────────────── */
{
  const mk = n => Array.from({ length: n }, (_, i) => ({
    id: i + 1, user: { login: 'u' }, body: `comment ${i}`,
    created_at: '2026-08-01T00:00:00Z', html_url: 'https://github.com/o/r/issues/42#issuecomment-x',
  }))

  console.log('\n── gh_analyze_issue: multi-page comments')
  const ctxA = new Context()
  const toolsA = new ToolsService(ctxA)
  new SystemPromptService(ctxA)
  await ctxA.plugin(plugin, undefined)
  requestLog.length = 0
  const handlersA = buildHandlers()
  handlersA.unshift([/\/repos\/o\/r\/issues\/42\/comments$/, (u) => {
    const page = Number(u.searchParams.get('page') ?? '1')
    return json(page === 1 ? mk(100) : page === 2 ? mk(100) : mk(50))
  }])
  globalThis.fetch = makeFetch(handlersA)
  const defA = toolsA.registry.get('gh_analyze_issue')
  const textA = await defA.execute({ owner: 'o', repo: 'r', issueNumber: 42 }, makeExec('gh_analyze_issue', {}))
  const commentPages = requestLog.filter(r => r.path === '/repos/o/r/issues/42/comments')
  check('walks all three pages', commentPages.length === 3, `pages: ${commentPages.length}`)
  check('full count rendered', textA.includes('Comments (250)'), textA.slice(0, 600))
  check('no truncation marker', !textA.includes('truncated'))
  await ctxA.fiber.dispose()

  console.log('\n── gh_analyze_issue: cap truncation')
  const ctxB = new Context()
  const toolsB = new ToolsService(ctxB)
  new SystemPromptService(ctxB)
  await ctxB.plugin(plugin, undefined)
  requestLog.length = 0
  const handlersB = buildHandlers()
  handlersB.unshift([/\/repos\/o\/r\/issues\/42\/comments$/, () => json(mk(100))])
  globalThis.fetch = makeFetch(handlersB)
  const defB = toolsB.registry.get('gh_analyze_issue')
  const textB = await defB.execute({ owner: 'o', repo: 'r', issueNumber: 42 }, makeExec('gh_analyze_issue', {}))
  check('cap marked as truncated', textB.includes('Comments (300+ truncated)'), textB.slice(0, 600))
  await ctxB.fiber.dispose()
}

/* ── error paths ─────────────────────────────────────────────────────────── */
{
  console.log('\n── error paths: 404 / 422 / rate limit / GraphQL fallback')
  const mkCtx = async () => {
    const ctx = new Context()
    const tools = new ToolsService(ctx)
    new SystemPromptService(ctx)
    await ctx.plugin(plugin, { requireApprovalForMutations: false })
    requestLog.length = 0
    return { ctx, tools }
  }

  // 404: analyze a missing issue.
  {
    const { ctx, tools } = await mkCtx()
    const handlers = buildHandlers()
    handlers.unshift([/\/repos\/o\/r\/issues\/42$/, () => json({ message: 'Not Found' }, 404)])
    globalThis.fetch = makeFetch(handlers)
    const def = tools.registry.get('gh_analyze_issue')
    let threw = null
    try {
      await def.execute({ owner: 'o', repo: 'r', issueNumber: 42 }, makeExec('gh_analyze_issue', {}))
    } catch (error) {
      threw = error
    }
    check('404 surfaces with message', threw !== null && String(threw.message).includes('Not Found'), threw !== null ? threw.message : 'no throw')
    await ctx.fiber.dispose()
  }

  // 422-style conflict: GraphQL merge returns errors (the REST merge endpoint
  // is not used — it returns 404 for OAuth tokens, verified live).
  {
    const { ctx, tools } = await mkCtx()
    const handlers = buildHandlers()
    handlers.unshift([/\/graphql$/, (u, method, accept, body) => {
      const query = body ? (JSON.parse(body).query ?? '') : ''
      if (query.includes('mergePullRequest')) {
        return json({ errors: [{ message: 'Merge conflict' }] })
      }
      return json({ data: { repository: { pullRequest: { id: 'pr-1' } } } })
    }])
    globalThis.fetch = makeFetch(handlers)
    const def = tools.registry.get('gh_merge_pr')
    let threw = null
    try {
      await def.execute({ owner: 'o', repo: 'r', pullNumber: 7 }, makeExec('gh_merge_pr', {}, FAKE_AGENT))
    } catch (error) {
      threw = error
    }
    check('merge conflict surfaces with message', threw !== null && String(threw.message).includes('Merge conflict'), threw !== null ? threw.message : 'no throw')
    await ctx.fiber.dispose()
  }

  // Rate limit: 403 with quota headers surfaces a self-heal hint.
  {
    const { ctx, tools } = await mkCtx()
    const handlers = buildHandlers()
    handlers.unshift([/\/search\/issues$/, () => json({ message: 'API rate limit exceeded' }, 403, {
      'x-ratelimit-remaining': '0',
      'x-ratelimit-reset': '1893456000',
    })])
    globalThis.fetch = makeFetch(handlers)
    const def = tools.registry.get('gh_search_related')
    const text = await def.execute({ query: 'rate limit', owner: 'o', repo: 'r' }, makeExec('gh_search_related', {}))
    check('rate limit hint surfaced', text.includes('rate limit exhausted') && text.includes('resets 2030'), text.slice(0, 300))
    await ctx.fiber.dispose()
  }

  // GraphQL failure: review analysis falls back to the REST comment list.
  {
    const { ctx, tools } = await mkCtx()
    const handlers = buildHandlers()
    handlers.unshift([/\/graphql$/, () => json({ errors: [{ message: 'Something went wrong' }] })])
    globalThis.fetch = makeFetch(handlers)
    const def = tools.registry.get('gh_review_pr')
    const text = await def.execute({ owner: 'o', repo: 'r', pullNumber: 7 }, makeExec('gh_review_pr', {}, FAKE_AGENT))
    check('GraphQL failure falls back to REST comments', text.includes('Existing review comments') && !text.includes('Review threads'), text.slice(0, 400))
    await ctx.fiber.dispose()
  }
}

console.log(failures === 0 ? '\nALL SMOKE CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
