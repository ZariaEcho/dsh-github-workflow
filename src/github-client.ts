/**
 * GitHub REST client for the workflow toolset.
 *
 * The client is a small typed wrapper around the global `fetch` (Node >= 20),
 * deliberately built instead of pulling in Octokit: the harness host runtime
 * already ships a modern fetch, and the REST surface this toolset needs is a
 * few dozen endpoints. Each tool resolves the token per call through the host
 * `credentials` seam (falling back to the process environment), so a changed
 * token reaches the next call without a plugin restart.
 *
 * @module dsh-github-workflow/github-client
 */

import type { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { ResolvedConfig } from './config.ts'

/** GitHub API version pinned on every request. */
export const GITHUB_API_VERSION = '2022-11-28'

/** Error carrying the HTTP status and the API's error message. */
export class GitHubError extends Error {
  /** HTTP status; 0 for transport-level failures (timeout, DNS, abort). */
  readonly status: number
  readonly method: string
  readonly url: string
  readonly documentationUrl: string | undefined

  constructor(
    status: number,
    method: string,
    url: string,
    message: string,
    documentationUrl: string | undefined,
  ) {
    super(message)
    this.name = 'GitHubError'
    this.status = status
    this.method = method
    this.url = url
    this.documentationUrl = documentationUrl
  }
}

/* ── GitHub API shapes (structural, non-exhaustive) ───────────────────────── */

export interface GitHubUser {
  login: string
}

export interface GitHubLabel {
  name: string
}

export interface GitHubIssue {
  number: number
  title: string
  state: 'open' | 'closed'
  state_reason?: string
  body: string | null
  user: GitHubUser | null
  labels: GitHubLabel[]
  milestone: { title: string } | null
  created_at: string
  updated_at: string
  comments: number
  html_url: string
  /** Present when the "issue" is actually a pull request. */
  pull_request?: { url: string; merged_at: string | null }
}

export interface GitHubComment {
  id: number
  user: GitHubUser | null
  body: string
  created_at: string
  html_url: string
}

export interface GitHubRepo {
  full_name: string
  description: string | null
  default_branch: string
  language: string | null
  stargazers_count: number
  forks_count: number
  open_issues_count: number
  archived: boolean
  topics: string[]
  html_url: string
}

export interface GitHubPullRequest {
  number: number
  title: string
  state: 'open' | 'closed'
  draft: boolean
  body: string | null
  html_url: string
  user: GitHubUser | null
  head: { ref: string; sha: string; repo: { full_name: string } | null }
  base: { ref: string; sha: string }
  created_at: string
  updated_at: string
  merged_at: string | null
  additions: number
  deletions: number
  changed_files: number
  mergeable: boolean | null
}

export interface GitHubPullRequestFile {
  filename: string
  status: string
  additions: number
  deletions: number
  changes: number
  raw_url: string
}

export interface GitHubCommit {
  sha: string
  commit: { message: string; author: { date: string } }
  author: GitHubUser | null
}

export interface GitHubCompare {
  status: string
  ahead_by: number
  behind_by: number
  commits: GitHubCommit[]
  files: GitHubPullRequestFile[]
}

export interface GitHubStatuses {
  state: 'success' | 'failure' | 'pending' | 'error'
  total_count: number
  statuses: Array<{
    context: string
    state: 'success' | 'failure' | 'pending' | 'error'
    target_url: string | null
    description: string | null
    created_at: string
  }>
}

export interface GitHubCheckRun {
  name: string
  status: 'queued' | 'in_progress' | 'completed'
  conclusion: string | null
  details_url: string
  started_at: string | null
  completed_at: string | null
}

export interface GitHubCheckRuns {
  total_count: number
  check_runs: GitHubCheckRun[]
}

export interface GitHubSearchResult {
  total_count: number
  items: Array<{
    number: number
    title: string
    state: 'open' | 'closed'
    html_url: string
    created_at: string
    updated_at: string
    comments: number
    user: GitHubUser | null
    labels: GitHubLabel[]
    pull_request?: { merged_at: string | null }
  }>
}

export interface GitHubCreatedPullRequest {
  number: number
  html_url: string
  title: string
  draft: boolean
  head: { ref: string }
  base: { ref: string }
}

export interface GitHubReview {
  id: number
  html_url: string
  state: string
  body: string | null
  submitted_at: string
  user: GitHubUser | null
}

/** One REST request. */
export interface RequestOptions {
  readonly method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  readonly path: string
  readonly query?: Readonly<Record<string, string | number | boolean | undefined>>
  readonly body?: unknown
  /** Media type override; the diff preview is the only use today. */
  readonly accept?: string
  readonly signal?: AbortSignal
}

/**
 * Minimal GitHub REST client. `token` is optional: read endpoints work
 * anonymously (subject to the 60 req/h IP rate limit) while mutating
 * endpoints require it.
 */
export class GitHubClient {
  readonly #baseUrl: string
  readonly #timeoutMs: number
  readonly #token: string | undefined
  /** Lazily cached result of the scope probe (`x-oauth-scopes` of `GET /user`). */
  #probedScopes: readonly string[] | undefined

  constructor(options: { baseUrl: string; timeoutMs: number; token?: string }) {
    this.#baseUrl = options.baseUrl
    this.#timeoutMs = options.timeoutMs
    this.#token = options.token
    this.#probedScopes = undefined
  }

  /** Whether an authentication token is configured for this client. */
  get authenticated(): boolean {
    return this.#token !== undefined && this.#token.length > 0
  }

  /**
   * Verify that the token's permission scopes cover `required`. Probes
   * `GET /user` once per client and reads the `x-oauth-scopes` header.
   * Fail-closed: a token that exposes no scope header (fine-grained tokens)
   * is denied, because the check cannot prove the required scope exists.
   *
   * @throws {@link GitHubError} when scopes are missing or unverifiable.
   */
  async assertTokenScopes(required: readonly string[]): Promise<void> {
    if (required.length === 0) return
    if (!this.authenticated) {
      throw new GitHubError(401, 'GET', '/user', 'a GitHub token is required for this operation', undefined)
    }
    const scopes = await this.#probeScopes()
    const missing = required.filter(scope => !scopes.includes(scope))
    if (missing.length > 0) {
      throw new GitHubError(
        403,
        'GET',
        '/user',
        `token is missing required scope(s): ${missing.join(', ')} (token has: ${scopes.join(', ') || 'none'})`,
        'https://docs.github.com/rest/authentication/permissions-required-for-fine-grained-personal-access-tokens',
      )
    }
  }

  async #probeScopes(): Promise<readonly string[]> {
    if (this.#probedScopes !== undefined) return this.#probedScopes
    const { headers } = await this.raw('GET', '/user')
    const value = headers.get('x-oauth-scopes')
    // Fine-grained tokens expose no scope header: an empty list means
    // "unverifiable", and the caller fails closed on it.
    const scopes: readonly string[] = value === null
      ? []
      : value.split(',').map(s => s.trim()).filter(s => s.length > 0)
    this.#probedScopes = scopes
    return scopes
  }

  /** Perform one request and return the parsed JSON body (or text for diff). */
  async request<T = unknown>(options: RequestOptions): Promise<T> {
    const { body } = await this.raw(options.method ?? 'GET', options.path, options)
    if (options.accept === 'application/vnd.github.v3.diff') return body as unknown as T
    if (body.length === 0) return undefined as unknown as T
    try {
      return JSON.parse(body) as T
    } catch {
      return body as unknown as T
    }
  }

  /** Perform one request and return the raw `Response` (for header reads). */
  async raw(
    method: string,
    path: string,
    options: { query?: RequestOptions['query']; body?: unknown; accept?: string; signal?: AbortSignal } = {},
  ): Promise<{ body: string; headers: Headers; status: number }> {
    const url = new URL(path.replace(/^\//, ''), `${this.#baseUrl}/`)
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value))
    }

    const headers: Record<string, string> = {
      accept: options.accept ?? 'application/vnd.github+json',
      'user-agent': 'dsh-github-workflow/0.1.0',
      'x-github-api-version': GITHUB_API_VERSION,
    }
    if (this.#token !== undefined && this.#token.length > 0) {
      headers.authorization = `Bearer ${this.#token}`
    }

    const init: RequestInit = {
      method,
      headers,
      signal: options.signal !== undefined
        ? AbortSignal.any([options.signal, AbortSignal.timeout(this.#timeoutMs)])
        : AbortSignal.timeout(this.#timeoutMs),
    }
    if (options.body !== undefined) {
      init.body = JSON.stringify(options.body)
      headers['content-type'] = 'application/json'
    }

    let response: Response
    try {
      response = await fetch(url, init)
    } catch (error) {
      const name = error instanceof Error ? error.name : ''
      if (name === 'AbortError') {
        throw new GitHubError(0, method, url.toString(), `request timed out after ${this.#timeoutMs}ms`, undefined)
      }
      throw new GitHubError(0, method, url.toString(), `request failed: ${String(error)}`, undefined)
    }

    const body = await response.text()
    if (!response.ok) {
      let message = `HTTP ${response.status}`
      let documentationUrl: string | undefined
      try {
        const parsed = JSON.parse(body) as { message?: string; documentation_url?: string }
        if (typeof parsed.message === 'string' && parsed.message.length > 0) message = parsed.message
        documentationUrl = parsed.documentation_url
      } catch {
        // Non-JSON error body; keep the HTTP status message.
      }
      throw new GitHubError(response.status, method, url.toString(), message, documentationUrl)
    }
    return { body, headers: response.headers, status: response.status }
  }

  /* ── typed endpoints ────────────────────────────────────────────────────── */

  getRepo(owner: string, repo: string): Promise<GitHubRepo> {
    return this.request({ path: `/repos/${enc(owner)}/${enc(repo)}` })
  }

  getIssue(owner: string, repo: string, issueNumber: number): Promise<GitHubIssue> {
    return this.request({ path: `/repos/${enc(owner)}/${enc(repo)}/issues/${issueNumber}` })
  }

  listIssueComments(owner: string, repo: string, issueNumber: number, perPage = 100): Promise<GitHubComment[]> {
    return this.request({
      path: `/repos/${enc(owner)}/${enc(repo)}/issues/${issueNumber}/comments`,
      query: { per_page: perPage },
    })
  }

  getPullRequest(owner: string, repo: string, pullNumber: number): Promise<GitHubPullRequest> {
    return this.request({ path: `/repos/${enc(owner)}/${enc(repo)}/pulls/${pullNumber}` })
  }

  getPullRequestDiff(owner: string, repo: string, pullNumber: number, signal?: AbortSignal): Promise<string> {
    const options: RequestOptions = {
      path: `/repos/${enc(owner)}/${enc(repo)}/pulls/${pullNumber}`,
      accept: 'application/vnd.github.v3.diff',
      ...(signal !== undefined ? { signal } : {}),
    }
    return this.request(options)
  }

  listPullRequestFiles(owner: string, repo: string, pullNumber: number, perPage = 100): Promise<GitHubPullRequestFile[]> {
    return this.request({
      path: `/repos/${enc(owner)}/${enc(repo)}/pulls/${pullNumber}/files`,
      query: { per_page: perPage },
    })
  }

  listPullRequests(owner: string, repo: string, state: 'open' | 'closed' | 'all' = 'open', perPage = 30): Promise<GitHubPullRequest[]> {
    return this.request({
      path: `/repos/${enc(owner)}/${enc(repo)}/pulls`,
      query: { state, per_page: perPage },
    })
  }

  branchExists(owner: string, repo: string, branch: string): Promise<boolean> {
    return this.request({ path: `/repos/${enc(owner)}/${enc(repo)}/branches/${enc(branch)}` })
      .then(() => true)
      .catch((error: unknown) => {
        if (error instanceof GitHubError && error.status === 404) return false
        throw error
      })
  }

  listCommits(owner: string, repo: string, branch: string, perPage = 30): Promise<GitHubCommit[]> {
    return this.request({
      path: `/repos/${enc(owner)}/${enc(repo)}/commits`,
      query: { sha: branch, per_page: perPage },
    })
  }

  getCompare(owner: string, repo: string, base: string, head: string): Promise<GitHubCompare> {
    return this.request({ path: `/repos/${enc(owner)}/${enc(repo)}/compare/${enc(base)}...${enc(head)}` })
  }

  getCombinedStatus(owner: string, repo: string, ref: string): Promise<GitHubStatuses> {
    return this.request({ path: `/repos/${enc(owner)}/${enc(repo)}/commits/${enc(ref)}/status` })
  }

  listCheckRuns(owner: string, repo: string, ref: string, perPage = 100): Promise<GitHubCheckRuns> {
    return this.request({
      path: `/repos/${enc(owner)}/${enc(repo)}/commits/${enc(ref)}/check-runs`,
      query: { per_page: perPage },
    })
  }

  searchIssues(query: string, perPage = 8): Promise<GitHubSearchResult> {
    return this.request({ path: '/search/issues', query: { q: query, per_page: perPage } })
  }

  searchCode(query: string, perPage = 5): Promise<{ total_count: number; items: Array<{ path: string; html_url: string }> }> {
    return this.request({ path: '/search/code', query: { q: query, per_page: perPage } })
  }

  createPullRequest(
    owner: string,
    repo: string,
    input: { title: string; head: string; base: string; body?: string; draft: boolean },
  ): Promise<GitHubCreatedPullRequest> {
    const body: Record<string, unknown> = {
      title: input.title,
      head: input.head,
      base: input.base,
      draft: input.draft,
    }
    if (input.body !== undefined) body.body = input.body
    return this.request({ method: 'POST', path: `/repos/${enc(owner)}/${enc(repo)}/pulls`, body })
  }

  submitPullRequestReview(
    owner: string,
    repo: string,
    pullNumber: number,
    input: { body: string; event: 'COMMENT' | 'APPROVE' | 'REQUEST_CHANGES' },
  ): Promise<GitHubReview> {
    return this.request({
      method: 'POST',
      path: `/repos/${enc(owner)}/${enc(repo)}/pulls/${pullNumber}/reviews`,
      body: { body: input.body, event: input.event },
    })
  }
}

/* ── token resolution and per-call deps ───────────────────────────────────── */

/**
 * Resolve the token reference through the host credentials seam, falling back
 * to the process environment when no credentials service is composed. Empty
 * values count as absent.
 */
export async function resolveGithubToken(ctx: Context, apiTokenEnv: string): Promise<string | undefined> {
  const credentials = ctx.get('credentials')
  if (credentials !== undefined) {
    const resolved = await credentials.resolve(credentialRef(apiTokenEnv))
    if (resolved !== undefined) return resolved.value
    return undefined
  }
  const value = process.env[apiTokenEnv]
  return value !== undefined && value.length > 0 ? value : undefined
}

/** Shared dependencies handed to every tool definition. */
export interface ToolDeps {
  readonly ctx: Context
  readonly config: ResolvedConfig
  /** Fresh client per call: token resolves at call time through the seam. */
  readonly client: () => Promise<GitHubClient>
}

/** Build the shared per-call dependencies. */
export function createToolDeps(ctx: Context, config: ResolvedConfig): ToolDeps {
  return {
    ctx,
    config,
    async client() {
      const token = await resolveGithubToken(ctx, config.apiTokenEnv)
      const options: { baseUrl: string; timeoutMs: number; token?: string } = {
        baseUrl: config.baseUrl,
        timeoutMs: config.timeoutMs,
      }
      if (token !== undefined) options.token = token
      return new GitHubClient(options)
    },
  }
}

/** Encode one path segment (branch names may contain slashes). */
function enc(value: string): string {
  return encodeURIComponent(value)
}
