// The OS secret stores Keysafe writes to, one per platform. Each operation is
// an argv plus stdin, so a secret never sits on a command line.

export const SERVICE = 'claude-keysafe'

export type Backend = 'macos' | 'linux' | 'windows'
export type Op = { argv: string[]; stdin?: string }

export const BACKEND_LABEL: Record<Backend, string> = {
  macos: 'macOS Keychain',
  linux: 'Secret Service',
  windows: 'Windows Credential Manager',
}

/** Which store `uname -s` points at; Windows when uname is missing or MSYS-flavoured. */
export function backendFor(uname: string | undefined): Backend | 'probe-linux' {
  if (uname === undefined || /MINGW|MSYS|CYGWIN|Windows/i.test(uname)) return 'windows'
  if (/Darwin/i.test(uname)) return 'macos'
  return 'probe-linux'
}

const ps = (script: string, ...args: string[]) => [
  'powershell.exe', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, ...args,
]

// `security -i` reads its command from stdin: the value is quoted, not argv.
const quote = (s: string) => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`

export function readOp(b: Backend, name: string, ps1: string): Op {
  if (b === 'macos') return { argv: ['security', 'find-generic-password', '-s', SERVICE, '-a', name, '-w'] }
  if (b === 'linux') return { argv: ['secret-tool', 'lookup', 'service', SERVICE, 'account', name] }
  return { argv: ps(ps1, 'get', name) }
}

export function saveOp(b: Backend, name: string, value: string, ps1: string): Op {
  if (b === 'macos') {
    return {
      argv: ['security', '-i'],
      stdin: `add-generic-password -s ${SERVICE} -a ${name} -l "keysafe ${name}" -w ${quote(value)}\n`,
    }
  }
  if (b === 'linux') {
    return { argv: ['secret-tool', 'store', '--label', `keysafe ${name}`, 'service', SERVICE, 'account', name], stdin: value }
  }
  return { argv: ps(ps1, 'set', name), stdin: value }
}

export function deleteOp(b: Backend, name: string, ps1: string): Op {
  if (b === 'macos') return { argv: ['security', 'delete-generic-password', '-s', SERVICE, '-a', name] }
  if (b === 'linux') return { argv: ['secret-tool', 'clear', 'service', SERVICE, 'account', name] }
  return { argv: ps(ps1, 'del', name) }
}

/**
 * Shell lines that export keys from the store at run time, so the plaintext is
 * never in the command text. On Windows each lookup starts PowerShell, so only
 * the keys the command names are exported, in one call.
 */
export function envPrefix(b: Backend, names: readonly string[], ps1: string, command: string): string {
  if (b === 'windows') {
    const used = names.filter(n => command.includes(n))
    if (used.length === 0) return ''
    const script = ps1.replace(/'/g, `'\\''`)
    return `eval "$(powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File '${script}' env ${used.join(' ')} | tr -d '\\r')"`
  }
  const lookup = (n: string) =>
    b === 'macos'
      ? `security find-generic-password -s ${SERVICE} -a ${n} -w 2>/dev/null`
      : `secret-tool lookup service ${SERVICE} account ${n} 2>/dev/null`
  return names.map(n => `export ${n}="$(${lookup(n)})"`).join('; ')
}

/** Lists the store's item names without reading any value; undefined where the store can't list. */
export function listOp(b: Backend): Op | undefined {
  return b === 'macos' ? { argv: ['security', 'dump-keychain'] } : undefined
}

/** The Keysafe account names in `security dump-keychain` output (attributes only, no secrets). */
export function parseKeychainNames(dump: string): string[] {
  const found = new Set<string>()
  for (const item of dump.split(/^keychain: /m)) {
    if (!item.includes(`"svce"<blob>="${SERVICE}"`)) continue
    const acct = /"acct"<blob>="([A-Za-z_][A-Za-z0-9_]*)"/.exec(item)?.[1]
    if (acct) found.add(acct)
  }
  return [...found].sort()
}
