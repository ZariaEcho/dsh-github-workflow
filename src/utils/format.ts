/**
 * Pure text-rendering helpers shared by every tool's output. Everything here
 * is deterministic and side-effect free.
 *
 * @module dsh-github-workflow/utils/format
 */

/** Shared text-only output projection used by every tool definition. */
export const TEXT_OUTPUT = {
  schema: { type: 'string' as const },
  render: (_args: unknown, value: string) => [{ type: 'text' as const, text: value }],
}

/** Truncate `text` to `maxChars` characters, keeping whole lines where cheap. */
export function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  const cut = text.slice(0, maxChars)
  const newline = cut.lastIndexOf('\n')
  const trimmed = newline > maxChars * 0.6 ? cut.slice(0, newline) : cut
  return `${trimmed}\n… (truncated, ${text.length - trimmed.length} chars omitted)`
}

/** Render one `key: value` line, collapsing newlines in the value. */
export function kv(key: string, value: string): string {
  return `${key}: ${value.replace(/\s*\n\s*/g, ' ').trim()}`
}

/** Render a markdown `### heading` section with an optional body. */
export function section(title: string, body = ''): string {
  const lines = [`### ${title}`]
  if (body.length > 0) lines.push('', body)
  return lines.join('\n')
}

/** Render bullet list items, skipping empty entries. */
export function bullet(items: readonly string[]): string {
  const nonEmpty = items.filter(item => item.trim().length > 0)
  if (nonEmpty.length === 0) return '- (none)'
  return nonEmpty.map(item => `- ${item.trim()}`).join('\n')
}

/** Render a pipe table with escaping; empty rows render `(none)`. */
export function table(headers: readonly string[], rows: readonly (readonly string[])[]): string {
  const escape = (cell: string) => cell.replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ')
  const head = `| ${headers.map(escape).join(' | ')} |`
  const sep = `| ${headers.map(() => '---').join(' | ')} |`
  if (rows.length === 0) return `${head}\n${sep}\n| ${headers.map(() => '(none)').join(' | ')} |`
  const body = rows.map(row => `| ${headers.map((_, i) => escape(row[i] ?? '')).join(' | ')} |`)
  return [head, sep, ...body].join('\n')
}

/** Relative time like `3d ago` / `5h ago` / `2m ago`, or `–` when absent. */
export function relativeTime(iso: string | null | undefined, now: number = Date.now()): string {
  if (iso === null || iso === undefined) return '–'
  const millis = Date.parse(iso)
  if (Number.isNaN(millis)) return '–'
  const delta = Math.max(0, now - millis)
  const minutes = Math.floor(delta / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days}d ago`
  const months = Math.floor(days / 30)
  if (months < 12) return `${months}mo ago`
  return `${Math.floor(months / 12)}y ago`
}

/** `1 file` / `3 files`. */
export function plural(count: number, singular: string, pluralWord = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralWord}`
}

/** `+12 −3`. */
export function diffStat(additions: number, deletions: number): string {
  return `+${additions} −${deletions}`
}

/** Render a fenced code block. */
export function codeBlock(language: string, text: string): string {
  return `\`\`\`${language}\n${text}\n\`\`\``
}

/** First non-empty line of `text`, truncated; `–` when absent. */
export function firstLine(text: string | null | undefined, maxChars = 160): string {
  if (text === null || text === undefined) return '–'
  const line = text.split('\n').find(line => line.trim().length > 0)
  if (line === undefined) return '–'
  const trimmed = line.trim()
  return trimmed.length > maxChars ? `${trimmed.slice(0, maxChars)}…` : trimmed
}

/** Short commit sha. */
export function shortSha(sha: string): string {
  return sha.slice(0, 7)
}

/** List-item extraction: markdown bullets and numbered items from a body. */
export function extractBullets(body: string | null | undefined, max = 12, maxChars = 160): string[] {
  if (body === null || body === undefined) return []
  const items: string[] = []
  for (const line of body.split('\n')) {
    const match = /^\s*(?:[-*]|\d+[.)])\s+(.+)$/.exec(line)
    if (match === null) continue
    const item = match[1]?.trim() ?? ''
    if (item.length === 0) continue
    items.push(item.length > maxChars ? `${item.slice(0, maxChars)}…` : item)
    if (items.length >= max) break
  }
  return items
}

/** Extract `#123`-style issue/PR references from free text. */
export function extractIssueRefs(text: string): number[] {
  const refs = new Set<number>()
  for (const match of text.matchAll(/(?<![A-Za-z0-9_])#(\d+)\b/g)) {
    const value = Number(match[1])
    if (Number.isSafeInteger(value)) refs.add(value)
  }
  return [...refs].sort((a, b) => a - b)
}
