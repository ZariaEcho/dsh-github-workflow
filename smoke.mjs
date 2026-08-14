/**
 * Smoke test for dsh-github-workflow (temporary validation script).
 *
 * Mounts the built plugin into a real cordis Context with stub `tools` /
 * `systemPrompt` services, and exercises tool executions against a stubbed
 * global fetch. Run: node smoke.mjs
 */

import { Context, Service } from '@deepseek-ai/cordis'
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
        return handler(u, method, accept)
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
    { name: 'ci/build', status: 'completed', conclusion: 'success', details_url: 'https://ci.example.com/1', started_at: '2026-08-11T09:00:00Z', completed_at: '2026-08-11T09:01:00Z' },
    { name: 'ci/lint', status: 'completed', conclusion: 'failure', details_url: 'https://ci.example.com/2', started_at: '2026-08-11T09:00:00Z', completed_at: '2026-08-11T09:01:00Z' },
  ],
}

function buildHandlers() {
  return [
    [/\/repos\/o\/r\/issues\/42\/comments$/, () => json(COMMENTS)],
    [/\/repos\/o\/r\/issues\/42$/, () => json(ISSUE)],
    [/\/repos\/o\/r\/branches\//, () => json({ name: 'fix/rate-limit' })],
    [/\/repos\/o\/r\/compare\//, () => json(COMPARE)],
    [/\/repos\/o\/r\/pulls\/7\/files$/, () => json(FILES)],
    [/\/repos\/o\/r\/pulls\/7$/, (u, method, accept) =>
      accept.includes('diff') ? new Response(DIFF, { status: 200 }) : json(PR)],
    [/\/repos\/o\/r\/pulls$/, (u, method) => {
      if (method === 'POST') {
        return json({ number: 88, html_url: 'https://github.com/o/r/pull/88', title: 't', draft: true, head: { ref: 'x' }, base: { ref: 'main' } }, 201)
      }
      return json([])
    }],
    [/\/repos\/o\/r\/pulls\/7\/reviews$/, () => json({ id: 1, html_url: 'https://github.com/o/r/pull/7#pullrequestreview-1', state: 'COMMENTED', body: 'b', submitted_at: '2026-08-11T10:00:00Z', user: { login: 'alice' } }, 200)],
    [/\/repos\/o\/r\/commits\/[^/]+\/check-runs$/, () => json(CHECK_RUNS)],
    [/\/repos\/o\/r\/commits\/[^/]+\/status$/, () => json(STATUS)],
    [/\/repos\/o\/r\/commits$/, () => json(COMMITS)],
    [/\/repos\/o\/r$/, () => json(REPO)],
    [/\/search\/issues$/, (u) => {
      const q = u.searchParams.get('q') ?? ''
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
  check('six tools registered', names.length === 6, names.join(', '))
  check(
    'tool names',
    JSON.stringify(names) === JSON.stringify([
      'gh_analyze_issue', 'gh_check_ci_status', 'gh_create_draft_pr',
      'gh_get_repo_context', 'gh_review_pr', 'gh_search_related',
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

console.log(failures === 0 ? '\nALL SMOKE CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
