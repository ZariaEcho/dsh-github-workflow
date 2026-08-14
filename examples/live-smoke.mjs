/**
 * Live, read-only network smoke for dsh-github-workflow.
 *
 * Validates the plugin's API-shape assumptions against the real GitHub REST
 * API (anonymous, IP rate limited to 60 req/h for core and 10/min for
 * search). Mounts the built plugin in a real cordis Context and executes the
 * read-only tools against the public octocat/Hello-World repository.
 *
 * Run from the project root after `npm run build`:
 *   node examples/live-smoke.mjs
 *
 * Optional: export GITHUB_TOKEN to lift the rate limits and exercise the
 * authenticated paths (code search, GraphQL threads).
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

const OWNER = 'octocat'
const REPO = 'Hello-World'
const ISSUE = 10852 // "Test Issue …" — stable enough for shape validation

let failures = 0
const check = (name, condition, detail = '') => {
  if (condition) {
    console.log(`  ok  ${name}`)
  } else {
    failures += 1
    console.log(`FAIL  ${name}${detail ? `\n      ${detail}` : ''}`)
  }
}

const makeExec = (name, args) => ({
  name,
  callId: `live-${name}`,
  rootCallId: `live-${name}`,
  arguments: args,
  agent: { id: 'live', name: 'live' },
  token: Symbol('live'),
  signal: new AbortController().signal,
})

const ctx = new Context()
const tools = new ToolsService(ctx)
new SystemPromptService(ctx)
await ctx.plugin(plugin, undefined)
const exec = (toolName, args) => tools.registry.get(toolName).execute(args, makeExec(toolName, args))

console.log('── live: gh_get_repo_context')
const repoText = await exec('gh_get_repo_context', { owner: OWNER, repo: REPO, depth: 3 })
check('repo header', repoText.includes(`# ${OWNER}/${REPO}`), repoText.slice(0, 200))
check('default branch from live API', repoText.includes('default branch: master'), repoText.slice(0, 300))
check('CODEOWNERS 404 handled', repoText.includes('(not found)'), repoText.slice(0, 400))
// Anonymous access to branch protection returns 401; the tool must render the
// "unknown — token needed" fallback rather than crashing.
check('protection 401 handled', repoText.includes('(not protected)') || repoText.includes('unknown'), repoText.slice(0, 400))

console.log('── live: gh_analyze_issue')
const issueText = await exec('gh_analyze_issue', { owner: OWNER, repo: REPO, issueNumber: ISSUE })
check('issue rendered', issueText.includes(`# Issue #${ISSUE} —`), issueText.slice(0, 200))
check('analysis scaffold', issueText.includes('Analysis scaffold'), issueText.slice(0, 200))

console.log('── live: gh_search_related')
const searchText = await exec('gh_search_related', { query: 'fork contribution', owner: OWNER, repo: REPO, limit: 3 })
check('search returns items', searchText.includes('hits:') && searchText.includes('##'), searchText.slice(0, 300))

console.log('── live: gh_check_ci_status')
const ciText = await exec('gh_check_ci_status', { owner: OWNER, repo: REPO, ref: 'master' })
check('ci empty path handled', ciText.includes('no statuses or check runs') || ciText.includes('Checks'), ciText.slice(0, 300))

console.log('── live: gh_generate_release_notes (same ref → error path)')
const releaseText = await exec('gh_generate_release_notes', { owner: OWNER, repo: REPO, from: 'master', to: 'master' })
check('same-ref guard', releaseText.includes('same ref'), releaseText.slice(0, 200))

await ctx.fiber.dispose()

console.log(failures === 0 ? '\nLIVE SMOKE PASSED' : `\n${failures} LIVE CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
