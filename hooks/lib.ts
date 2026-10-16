// Pure helpers, kept apart from the hooks so tests can reach them directly.

// Known key formats a paste is checked against, each with the env name it gets.
const PATTERNS: readonly { re: RegExp; name: string; label: string }[] = [
  { re: /sk-ant-[A-Za-z0-9_-]{20,}/g, name: 'ANTHROPIC_API_KEY', label: 'an Anthropic API key' },
  { re: /sk-(?:proj-)?[A-Za-z0-9_-]{32,}/g, name: 'OPENAI_API_KEY', label: 'an OpenAI API key' },
  { re: /(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}/g, name: 'STRIPE_SECRET_KEY', label: 'a Stripe secret key' },
  { re: /(?:ghp|gho|ghu|ghs)_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,}/g, name: 'GITHUB_TOKEN', label: 'a GitHub token' },
  { re: /AKIA[0-9A-Z]{16}/g, name: 'AWS_ACCESS_KEY_ID', label: 'an AWS access key' },
  { re: /xox[abprs]-[A-Za-z0-9-]{10,}/g, name: 'SLACK_TOKEN', label: 'a Slack token' },
  { re: /AIza[0-9A-Za-z_-]{35}/g, name: 'GOOGLE_API_KEY', label: 'a Google API key' },
  { re: /sbp_[A-Za-z0-9]{30,}/g, name: 'SUPABASE_ACCESS_TOKEN', label: 'a Supabase access token' },
  { re: /glpat-[A-Za-z0-9_-]{20,}/g, name: 'GITLAB_TOKEN', label: 'a GitLab token' },
]

export type Found = { value: string; name: string; label: string }

/** `sk_live_abcd…wxyz`: enough to recognise a key, not enough to use it. */
export function mask(value: string): string {
  return value.length <= 14 ? `${value.slice(0, 4)}…` : `${value.slice(0, 8)}…${value.slice(-4)}`
}

/** Every key-shaped string in `text`, first match per value, in order. */
export function detectKeys(text: string): Found[] {
  const seen = new Map<string, Found>()
  for (const { re, name, label } of PATTERNS) {
    for (const m of text.matchAll(re)) {
      if (!seen.has(m[0]) && ![...seen.keys()].some(v => v.includes(m[0]))) {
        seen.set(m[0], { value: m[0], name, label })
      }
    }
  }
  return [...seen.values()]
}

/** `stripe key` -> `STRIPE_KEY`; undefined when nothing usable is left. */
export function toEnvName(raw: string): string | undefined {
  const name = raw.trim().toUpperCase().replace(/[^A-Z0-9_]+/g, '_').replace(/^_+|_+$/g, '')
  return /^[A-Z_][A-Z0-9_]*$/.test(name) ? name : undefined
}

/** `base`, or `base_2`, `base_3`... whichever is not in `taken`. */
export function uniqueName(base: string, taken: readonly string[]): string {
  if (!taken.includes(base)) return base
  let n = 2
  while (taken.includes(`${base}_${n}`)) n++
  return `${base}_${n}`
}

/** `text` with every known value replaced by `[keysafe:NAME]`. */
export function redact(text: string, values: ReadonlyMap<string, string>): string {
  let out = text
  // Longest first, so a value that contains another is replaced whole.
  const pairs = [...values].filter(([, v]) => v.length >= 8).sort((a, b) => b[1].length - a[1].length)
  for (const [name, value] of pairs) out = out.split(value).join(`[keysafe:${name}]`)
  return out
}

type Block = { type: string; [field: string]: unknown }

/** A message's blocks with text and tool results redacted; same array when nothing changed. */
export function redactBlocks(blocks: Block[], values: ReadonlyMap<string, string>): Block[] {
  let changed = false
  const fix = (s: string) => {
    const r = redact(s, values)
    if (r !== s) changed = true
    return r
  }
  const next = blocks.map(b => {
    if (b.type === 'text' && typeof b.text === 'string') return { ...b, text: fix(b.text) }
    if (b.type === 'tool_result') {
      if (typeof b.content === 'string') return { ...b, content: fix(b.content) }
      if (Array.isArray(b.content)) {
        return {
          ...b,
          content: b.content.map((c: Block) =>
            c.type === 'text' && typeof c.text === 'string' ? { ...c, text: fix(c.text) } : c,
          ),
        }
      }
    }
    return b
  })
  return changed ? next : blocks
}
