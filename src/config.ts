/**
 * Configuration surface, schemastery schema, and resolved runtime config for
 * `dsh-github-workflow`.
 *
 * @module dsh-github-workflow/config
 */

import z from '@deepseek-ai/schemastery'

/** Plugin configuration surface (all fields optional; schema applies defaults). */
export interface Config {
  /**
   * Environment-variable reference that carries the GitHub token. The token is
   * resolved per call through the host `credentials` seam (managed
   * `.credentials.yaml`, `.env` files, process environment), never cached.
   * Defaults to `GITHUB_TOKEN`.
   */
  apiTokenEnv?: string
  /**
   * GitHub REST API base URL. Defaults to `https://api.github.com`; override
   * for GitHub Enterprise Server (e.g. `https://gh.example.com/api/v3`).
   */
  baseUrl?: string
  /** Cooperative per-request timeout in milliseconds. Defaults to 60000. */
  timeoutMs?: number
  /**
   * Read-only mode: every mutating tool (`gh_create_draft_pr`, and
   * `gh_review_pr` with `post: true`) refuses with a clear message while this
   * is enabled. Query/analysis tools are unaffected. Defaults to `false`.
   */
  readOnly?: boolean
  /**
   * Gate every mutating tool call behind the host approval service, which
   * asks the user through the session's approval policy. With no approval
   * service composed, mutations fail closed. Defaults to `true`.
   */
  requireApprovalForMutations?: boolean
  /**
   * Token permission scopes required for mutating calls, verified against the
   * token's `x-oauth-scopes` header (classic tokens) before the mutation is
   * sent. A token that cannot be verified (fine-grained tokens expose no such
   * header) is denied with a clear message. Empty means no scope check.
   * Defaults to `[]`. Examples: `['repo']`, `['repo', 'workflow']`.
   */
  requiredTokenScopes?: string[]
}

/** Schemastery config used by the Loader for defaults and generated docs. */
export const Config: z<Config> = z.object({
  apiTokenEnv: z.string().default('GITHUB_TOKEN'),
  baseUrl: z.string().default('https://api.github.com'),
  timeoutMs: z.number().step(1).min(1000).max(300_000).default(60_000),
  readOnly: z.boolean().default(false),
  requireApprovalForMutations: z.boolean().default(true),
  requiredTokenScopes: z.array(z.string()).default([]),
})

/** Fully resolved, validated runtime configuration. */
export interface ResolvedConfig {
  readonly apiTokenEnv: string
  readonly baseUrl: string
  readonly timeoutMs: number
  readonly readOnly: boolean
  readonly requireApprovalForMutations: boolean
  readonly requiredTokenScopes: readonly string[]
}

/** Validate and normalize the raw plugin configuration. */
export function resolveConfig(config: Config): ResolvedConfig {
  const apiTokenEnv = config.apiTokenEnv ?? 'GITHUB_TOKEN'
  const baseUrl = (config.baseUrl ?? 'https://api.github.com').replace(/\/+$/, '')
  const timeoutMs = config.timeoutMs ?? 60_000
  const readOnly = config.readOnly ?? false
  const requireApprovalForMutations = config.requireApprovalForMutations ?? true
  const requiredTokenScopes = [...(config.requiredTokenScopes ?? [])]

  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(apiTokenEnv)) {
    throw new TypeError(`github-workflow: apiTokenEnv "${apiTokenEnv}" must look like an environment-variable name`)
  }
  if (!/^https?:\/\//.test(baseUrl)) {
    throw new TypeError(`github-workflow: baseUrl "${baseUrl}" must be an absolute http(s) URL`)
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 300_000) {
    throw new TypeError('github-workflow: timeoutMs must be an integer between 1000 and 300000')
  }
  for (const scope of requiredTokenScopes) {
    if (!/^[A-Za-z][A-Za-z0-9:_-]*$/.test(scope)) {
      throw new TypeError(`github-workflow: requiredTokenScopes entry "${scope}" is not a valid GitHub scope`)
    }
  }
  return { apiTokenEnv, baseUrl, timeoutMs, readOnly, requireApprovalForMutations, requiredTokenScopes }
}
