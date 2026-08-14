/**
 * In-process repository context cache, optionally persisted to a JSON file,
 * namespaced per mounting configuration.
 *
 * Slow-moving repository facts (CODEOWNERS, branch protection, PR template)
 * are cached per `owner/repo` for a configurable TTL, so repeated analysis
 * calls in one process do not re-fetch them. Every mounting configuration
 * (identified by its cache path, or `default` when memory-only) owns an
 * isolated namespace: two plugin instances with different cache paths never
 * read or evict each other's entries. When a namespace has a file path,
 * entries are loaded from that file on first access and written back on every
 * change (synchronous, best-effort — a failing read or write never breaks an
 * operation). The cache never stores tokens or per-request data.
 *
 * @module dsh-github-workflow/utils/cache
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

interface CacheEntry {
  readonly value: unknown
  readonly expiresAt: number
}

interface NamespaceState {
  path: string
  loaded: boolean
}

/** `${ns}:${key}` → entry. */
const entries = new Map<string, CacheEntry>()
const states = new Map<string, NamespaceState>()

/**
 * (Re)initialize one namespace: point it at a persistence file (empty =
 * memory only) and drop its entries so the next access reloads. Called on
 * every plugin apply with the mounting configuration's identity. Deliberately
 * does NOT persist here — writing the (now empty) memory view would destroy
 * the durable copy before the next access reloads it.
 */
export function initRepoFactsCache(path: string, ns: string): void {
  states.set(ns, { path, loaded: false })
  const prefix = `${ns}:`
  for (const key of [...entries.keys()]) {
    if (key.startsWith(prefix)) entries.delete(key)
  }
}

function ensureLoaded(ns: string): void {
  const state = states.get(ns)
  if (state === undefined) return // unknown namespace: memory-only passthrough
  if (state.loaded) return
  state.loaded = true
  if (state.path === '') return
  try {
    if (!existsSync(state.path)) return
    const raw = readFileSync(state.path, 'utf8')
    const parsed = JSON.parse(raw) as Array<[string, unknown, number]>
    const now = Date.now()
    const prefix = `${ns}:`
    for (const [key, value, expiresAt] of parsed) {
      if (typeof key === 'string' && typeof expiresAt === 'number' && expiresAt > now) {
        entries.set(prefix + key, { value, expiresAt })
      }
    }
  } catch {
    // Corrupted or unreadable cache file: ignore and start fresh.
  }
}

function persist(ns: string): void {
  const state = states.get(ns)
  if (state === undefined || state.path === '') return
  try {
    mkdirSync(dirname(state.path), { recursive: true })
    const prefix = `${ns}:`
    const rows: Array<[string, unknown, number]> = []
    for (const [key, entry] of entries) {
      if (key.startsWith(prefix)) rows.push([key.slice(prefix.length), entry.value, entry.expiresAt])
    }
    writeFileSync(state.path, JSON.stringify(rows))
  } catch {
    // Cache persistence is best-effort.
  }
}

/**
 * Load `loader` and memoize its result under `key` for `ttlMs` in `ns`.
 * `ttlMs <= 0` disables caching for the call. Concurrent loads of the same
 * key are not deduplicated — acceptable for this call pattern.
 */
export async function cachedRepoFacts<T>(
  key: string,
  ttlMs: number,
  loader: () => Promise<T>,
  ns = 'default',
): Promise<T> {
  if (ttlMs <= 0) return loader()
  ensureLoaded(ns)
  const now = Date.now()
  const fullKey = `${ns}:${key}`
  const hit = entries.get(fullKey)
  if (hit !== undefined && hit.expiresAt > now) return hit.value as T
  const value = await loader()
  entries.set(fullKey, { value, expiresAt: now + ttlMs })
  persist(ns)
  return value
}

/**
 * Drop every cached fact for one repository in `ns` (default-branch
 * governance and PR template). Mutating tools call this after a state change
 * so the next read refetches fresh facts.
 */
export function invalidateRepo(owner: string, repo: string, ns = 'default'): void {
  const prefix = `${ns}:`
  entries.delete(`${prefix}repo-context:${owner}/${repo}`)
  entries.delete(`${prefix}pr-template:${owner}/${repo}`)
  persist(ns)
}

/** Drop every entry of one namespace (used by tests and configuration reloads). */
export function clearRepoFactsCache(ns = 'default'): void {
  const prefix = `${ns}:`
  for (const key of [...entries.keys()]) {
    if (key.startsWith(prefix)) entries.delete(key)
  }
  persist(ns)
}

/** Number of live entries in one namespace (used by tests). */
export function repoFactsCacheSize(ns = 'default'): number {
  const prefix = `${ns}:`
  let count = 0
  for (const key of entries.keys()) {
    if (key.startsWith(prefix)) count += 1
  }
  return count
}
