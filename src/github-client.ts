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
import type {
  GitHubAnnotation,
  GitHubBranchProtection,
  GitHubCheckRun,
  GitHubCheckRuns,
  GitHubComment,
  GitHubCommit,
  GitHubCompare,
  GitHubCreatedPullRequest,
  GitHubIssue,
  GitHubMergeResult,
  GitHubPullRequest,
  GitHubPullRequestFile,
  GitHubRepo,
  GitHubRequestedReviewers,
  GitHubReview,
  GitHubReviewComment,
  GitHubSearchResult,
  GitHubStatuses,
  Paged,
} from './types.ts'

export type {
  GitHubAnnotation,
  GitHubBranchProtection,
  GitHubCheckRun,
  GitHubCheckRuns,
  GitHubComment,
  GitHubCommit,
  GitHubCompare,
  GitHubCreatedPullRequest,
  GitHubIssue,
  GitHubLabel,
  GitHubMergeResult,
  GitHubPullRequest,
  GitHubPullRequestFile,
  GitHubRepo,
  GitHubRequestedReviewers,
  GitHubReview,
  GitHubReviewComment,
  GitHubSearchResult,
  GitHubStatuses,
  GitHubUser,
} from './types.ts'

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

  /** Default cap for paginated list endpoints. */
  static readonly PAGINATION_CAP = 300
  static readonly PAGINATION_PAGE_SIZE = 100

  /**
   * Walk every page of a list endpoint until the page returns short or the
   * cap is reached. `truncated` is true only when the loop stopped at the cap
   * with a full last page, i.e. more items may exist.
   */
  protected async paginate<T>(
    path: string,
    query: RequestOptions['query'],
    cap: number = GitHubClient.PAGINATION_CAP,
    perPage: number = GitHubClient.PAGINATION_PAGE_SIZE,
  ): Promise<Paged<T>> {
    const items: T[] = []
    for (let page = 1; ; page += 1) {
      const batch = await this.request<T[]>({
        path,
        query: { ...query, per_page: perPage, page },
      })
      items.push(...batch)
      const hitCap = items.length >= cap
      if (batch.length < perPage || hitCap) {
        return { items, truncated: hitCap && batch.length === perPage }
      }
    }
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
      message += rateLimitHint(response)
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

  listIssueComments(
    owner: string,
    repo: string,
    issueNumber: number,
    cap: number = GitHubClient.PAGINATION_CAP,
  ): Promise<Paged<GitHubComment>> {
    return this.paginate<GitHubComment>(
      `/repos/${enc(owner)}/${enc(repo)}/issues/${issueNumber}/comments`,
      {},
      cap,
    )
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

  listPullRequestFiles(
    owner: string,
    repo: string,
    pullNumber: number,
    cap: number = GitHubClient.PAGINATION_CAP,
  ): Promise<Paged<GitHubPullRequestFile>> {
    return this.paginate<GitHubPullRequestFile>(
      `/repos/${enc(owner)}/${enc(repo)}/pulls/${pullNumber}/files`,
      {},
      cap,
    )
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

  getCommit(owner: string, repo: string, ref: string): Promise<GitHubCommit> {
    return this.request({ path: `/repos/${enc(owner)}/${enc(repo)}/commits/${enc(ref)}` })
  }

  getCompare(owner: string, repo: string, base: string, head: string): Promise<GitHubCompare> {
    return this.request({ path: `/repos/${enc(owner)}/${enc(repo)}/compare/${enc(base)}...${enc(head)}` })
  }

  getCombinedStatus(owner: string, repo: string, ref: string): Promise<GitHubStatuses> {
    return this.request({ path: `/repos/${enc(owner)}/${enc(repo)}/commits/${enc(ref)}/status` })
  }

  async listCheckRuns(
    owner: string,
    repo: string,
    ref: string,
    cap: number = GitHubClient.PAGINATION_CAP,
  ): Promise<GitHubCheckRuns & { truncated: boolean }> {
    const path = `/repos/${enc(owner)}/${enc(repo)}/commits/${enc(ref)}/check-runs`
    const all: GitHubCheckRun[] = []
    let total = 0
    let truncated = false
    for (let page = 1; ; page += 1) {
      const batch = await this.request<GitHubCheckRuns>({
        path,
        query: { per_page: GitHubClient.PAGINATION_PAGE_SIZE, page },
      })
      total = batch.total_count
      all.push(...batch.check_runs)
      const hitCap = all.length >= cap
      if (batch.check_runs.length < GitHubClient.PAGINATION_PAGE_SIZE || hitCap) {
        truncated = hitCap && batch.check_runs.length === GitHubClient.PAGINATION_PAGE_SIZE
        break
      }
    }
    return { total_count: total, check_runs: all, truncated }
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

  mergePullRequest(
    owner: string,
    repo: string,
    pullNumber: number,
    input: { mergeMethod: 'merge' | 'squash' | 'rebase'; commitTitle?: string; commitMessage?: string },
  ): Promise<GitHubMergeResult> {
    const body: Record<string, unknown> = { merge_method: input.mergeMethod }
    if (input.commitTitle !== undefined) body.commit_title = input.commitTitle
    if (input.commitMessage !== undefined) body.commit_message = input.commitMessage
    return this.request({
      method: 'POST',
      path: `/repos/${enc(owner)}/${enc(repo)}/pulls/${pullNumber}/merge`,
      body,
    })
  }

  closeIssue(
    owner: string,
    repo: string,
    issueNumber: number,
    stateReason?: 'completed' | 'not_planned',
  ): Promise<GitHubIssue> {
    const body: Record<string, unknown> = { state: 'closed' }
    if (stateReason !== undefined) body.state_reason = stateReason
    return this.request({
      method: 'PATCH',
      path: `/repos/${enc(owner)}/${enc(repo)}/issues/${issueNumber}`,
      body,
    })
  }

  deleteBranch(owner: string, repo: string, branch: string): Promise<void> {
    return this.request({
      method: 'DELETE',
      path: `/repos/${enc(owner)}/${enc(repo)}/git/refs/heads/${enc(branch)}`,
    })
  }

  requestReviewers(
    owner: string,
    repo: string,
    pullNumber: number,
    input: { reviewers: string[]; teamReviewers?: string[] },
  ): Promise<GitHubRequestedReviewers> {
    const body: Record<string, unknown> = { reviewers: input.reviewers }
    if (input.teamReviewers !== undefined && input.teamReviewers.length > 0) {
      body.team_reviewers = input.teamReviewers
    }
    return this.request({
      method: 'POST',
      path: `/repos/${enc(owner)}/${enc(repo)}/pulls/${pullNumber}/requested_reviewers`,
      body,
    })
  }

  listPullRequestReviewComments(
    owner: string,
    repo: string,
    pullNumber: number,
    cap: number = GitHubClient.PAGINATION_CAP,
  ): Promise<Paged<GitHubReviewComment>> {
    return this.paginate<GitHubReviewComment>(
      `/repos/${enc(owner)}/${enc(repo)}/pulls/${pullNumber}/comments`,
      {},
      cap,
    )
  }

  /** Reply inside an existing review-comment thread on a pull request. */
  replyToReviewComment(
    owner: string,
    repo: string,
    pullNumber: number,
    commentId: number,
    body: string,
  ): Promise<GitHubReviewComment> {
    return this.request({
      method: 'POST',
      path: `/repos/${enc(owner)}/${enc(repo)}/pulls/${pullNumber}/comments`,
      body: { body, in_reply_to: commentId },
    })
  }

  /** Reply inside an existing issue-comment thread. */
  replyToIssueComment(
    owner: string,
    repo: string,
    issueNumber: number,
    commentId: number,
    body: string,
  ): Promise<GitHubComment> {
    return this.request({
      method: 'POST',
      path: `/repos/${enc(owner)}/${enc(repo)}/issues/${issueNumber}/comments`,
      body: { body, in_reply_to: commentId },
    })
  }

  listCheckRunAnnotations(owner: string, repo: string, checkRunId: number, perPage = 50): Promise<GitHubAnnotation[]> {
    return this.request({
      path: `/repos/${enc(owner)}/${enc(repo)}/check-runs/${checkRunId}/annotations`,
      query: { per_page: perPage },
    })
  }

  /**
   * Raw file content via the contents API (404 → undefined). The `path` is
   * joined with raw slashes (`path/to/file`), the documented contents-API
   * form; only callers with fixed internal paths may use this.
   */
  async getFileContentRaw(owner: string, repo: string, path: string): Promise<string | undefined> {
    try {
      return await this.request<string>({
        path: `/repos/${enc(owner)}/${enc(repo)}/contents/${path}`,
        accept: 'application/vnd.github.raw',
      })
    } catch (error) {
      if (error instanceof GitHubError && error.status === 404) return undefined
      throw error
    }
  }

  /** Branch protection for one branch; 404 → null (not protected). */
  async getBranchProtection(owner: string, repo: string, branch: string): Promise<GitHubBranchProtection | null> {
    try {
      return await this.request<GitHubBranchProtection>({
        path: `/repos/${enc(owner)}/${enc(repo)}/branches/${enc(branch)}/protection`,
      })
    } catch (error) {
      if (error instanceof GitHubError && error.status === 404) return null
      throw error
    }
  }

  /** One GraphQL request (requires a token; the GraphQL API has no anonymous access). */
  graphql<T = unknown>(query: string, variables: Record<string, unknown>): Promise<T> {
    return this.request({
      method: 'POST',
      path: '/graphql',
      body: { query, variables },
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
  /** Cache namespace for this mounting configuration (isolated per cache path). */
  readonly cacheNs: string
  /** Fresh client per call: token resolves at call time through the seam. */
  readonly client: () => Promise<GitHubClient>
}

/** Build the shared per-call dependencies. */
export function createToolDeps(ctx: Context, config: ResolvedConfig): ToolDeps {
  const cacheNs = config.contextCachePath === '' ? 'default' : `file:${config.contextCachePath}`
  return {
    ctx,
    config,
    cacheNs,
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

/**
 * Rate-limit context for an error response, appended to the error message so
 * the model can self-heal (wait, or tell the user to raise the quota):
 * - `Retry-After` on 403/429 — secondary rate limit, wait that many seconds.
 * - `x-ratelimit-remaining: 0` — quota exhausted; `x-ratelimit-reset` gives
 *   the epoch-seconds reset time when present.
 */
function rateLimitHint(response: Response): string {
  const retryAfter = response.headers.get('retry-after')
  if (retryAfter !== null) {
    return ` (secondary rate limit: retry after ${retryAfter}s)`
  }
  const remaining = response.headers.get('x-ratelimit-remaining')
  if (remaining === '0') {
    const reset = response.headers.get('x-ratelimit-reset')
    if (reset !== null && /^\d+$/.test(reset)) {
      return ` (rate limit exhausted; resets ${new Date(Number(reset) * 1000).toISOString()})`
    }
    return ' (rate limit exhausted)'
  }
  if (remaining !== null && response.status === 403) {
    const reset = response.headers.get('x-ratelimit-reset')
    if (reset !== null && /^\d+$/.test(reset)) {
      return ` (rate limit: ${remaining} remaining; resets ${new Date(Number(reset) * 1000).toISOString()})`
    }
    return ` (rate limit: ${remaining} remaining)`
  }
  return ''
}
