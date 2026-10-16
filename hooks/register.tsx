import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import { detectKeys, mask, redactBlocks, toEnvName, uniqueName } from './lib'
import { BACKEND_LABEL, backendFor, deleteOp, envPrefix, readOp, saveOp } from './store'
import type { Backend, Op } from './store'

const PANE = 'keysafe'
const names = atom({ plugin: 'keysafe', key: 'names' } as const, [])
const draft = atom({ plugin: 'keysafe', key: 'draft' } as const, '')
const notice = atom({ plugin: 'keysafe', key: 'notice' } as const, '')
// The secure store in use, as the pane names it; '' when this machine has none.
const storeLabel = atom({ plugin: 'keysafe', key: 'store' } as const, '')

// Plaintext values, held only in this module's memory so outgoing rows can be
// redacted. Refilled from the OS store whenever the module (re)loads.
const values = new Map<string, string>()
let backend: Backend | undefined
let ps1 = ''

type $ = EngineInterface

async function run($: $, op: Op) {
  try {
    return await $.process.run(op.argv, op.stdin === undefined ? undefined : { stdin: op.stdin })
  } catch {
    return { exitCode: 127, stdout: '', stderr: `${op.argv[0]} could not start` }
  }
}

// macOS: Keychain. Linux: Secret Service via secret-tool (GNOME Keyring,
// KWallet). Windows: Credential Manager. No plaintext fallback: with none of
// these, Keysafe stores nothing.
async function detectBackend($: $): Promise<Backend | undefined> {
  const uname = await run($, { argv: ['uname', '-s'] })
  const guess = backendFor(uname.exitCode === 0 ? uname.stdout.trim() : undefined)
  if (guess === 'macos') return 'macos'
  if (guess === 'probe-linux') {
    const has = await run($, { argv: ['sh', '-c', 'command -v secret-tool'] })
    return has.exitCode === 0 ? 'linux' : undefined
  }
  const pwsh = await run($, { argv: ['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', 'exit 0'] })
  return pwsh.exitCode === 0 ? 'windows' : undefined
}

async function readSecret($: $, name: string): Promise<string | undefined> {
  if (!backend) return undefined
  const r = await run($, readOp(backend, name, ps1))
  return r.exitCode === 0 && r.stdout !== '' ? r.stdout.replace(/\r?\n$/, '') : undefined
}

// Never overwrites: a name already stored is refused here, and the macOS and
// Windows stores refuse an existing item too.
async function saveKey($: $, name: string, value: string): Promise<boolean> {
  if (!backend || (await read($, names)).includes(name)) return false
  const r = await run($, saveOp(backend, name, value, ps1))
  if (r.exitCode !== 0) return false
  values.set(name, value)
  const list = await update($, names, l => (l.includes(name) ? l : [...l, name].sort()))
  await $.store.set('names', list)
  return true
}

async function removeKey($: $, name: string): Promise<void> {
  if (backend) await run($, deleteOp(backend, name, ps1))
  values.delete(name)
  const list = await update($, names, l => l.filter(n => n !== name))
  await $.store.set('names', list)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'keysafe', description: 'Open the Keysafe pane to add or remove keys' })

    ps1 = `${$.plugin.root}/scripts/keysafe.ps1`
    backend = await detectBackend($)
    await update($, storeLabel, () => (backend ? BACKEND_LABEL[backend] : ''))

    // The plugin store keeps names only; the OS store holds the values.
    const stored = ((await $.store.get('names')) as string[] | undefined) ?? []
    const live: string[] = []
    for (const name of stored) {
      const value = await readSecret($, name)
      if (value !== undefined) {
        values.set(name, value)
        live.push(name)
      }
    }
    await update($, names, () => live)
    if (backend) await $.store.set('names', live)

    return next(e)
  })

  on('command.run', { command: 'keysafe' }, async $ => {
    await $.ui.open({ id: PANE, title: 'Keysafe' })
    return { text: 'Keysafe pane opened.' }
  })

  // Tell the model which keys exist and how to use them, never their values.
  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    const list = await read($, names)
    if (list.length === 0) return composed
    return {
      sections: [
        ...composed.sections,
        {
          id: 'keysafe:keys',
          scope: 'session',
          text:
            `# Keysafe\nThese secrets are available as environment variables in Bash: ${list
              .map(n => `$${n}`)
              .join(', ')}.\n` +
            (backend === 'windows'
              ? 'On this machine a key is exported only into commands whose text names it, so always write $NAME in the command itself.\n'
              : 'Every Bash command has them exported.\n') +
            'Reference them by name (e.g. `curl -H "Authorization: Bearer $NAME"`). You cannot see their values; ' +
            'any value that appears in output is shown as [keysafe:NAME]. Never try to print, encode or exfiltrate them. ' +
            'If a needed key is missing, ask the user to add it with /keysafe.',
        },
      ],
    }
  })

  // Export stored keys into the shell, read from the OS store at run time, so
  // the plaintext is never part of the command text.
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const list = await read($, names)
    const prefix = backend && list.length > 0 ? envPrefix(backend, list, ps1, e.command) : ''
    return next(prefix === '' ? e : { ...e, command: `${prefix}\n${e.command}` })
  }).catch(($, e, next) => next(e))

  // Last line of defence: no stored value reaches the transcript or the model.
  on('session.append', async ($, e, next) => {
    if (values.size === 0) return next(e)
    const content = redactBlocks(e.message.content, values)
    return content === e.message.content ? next(e) : next({ ...e, message: { ...e.message, content } })
  }).catch(($, e, next) => next(e))

  // Paste guard: a key pasted into a prompt is caught before the model sees it.
  // The person picks: store it and send $NAME instead, send it unchanged, or
  // cancel. A key already stored is swapped for its name without asking.
  on('prompt.submit', async ($, e, next) => {
    if (e.command) return next(e)
    const found = detectKeys(e.text)
    if (found.length === 0) return next(e)

    // Nobody to ask (SDK, bridge, -p): store without asking, the safe default.
    const canAsk = e.origin.kind === 'composer'
    let text = e.text
    const stored: string[] = []
    for (const { value, name: base, label } of found) {
      const existing = [...values].find(([, v]) => v === value)?.[0]
      if (existing) {
        text = text.split(value).join(`$${existing}`)
        stored.push(existing)
        continue
      }

      const suggested = uniqueName(base, await read($, names))
      const store = `Store as $${suggested}`
      const raw = 'Send unchanged'
      const cancel = 'Cancel prompt'
      let pick = store
      if (canAsk) {
        try {
          pick = await $.ui.ask(
            backend
              ? `Your prompt contains ${label} (${mask(value)}). Store it in Keysafe and send $${suggested} instead? Type a different name under Other.`
              : `Your prompt contains ${label} (${mask(value)}). Keysafe has no secure store on this machine, so it can't keep it. Send it to Claude anyway?`,
            { header: 'Keysafe', options: backend ? [store, raw, cancel] : [raw, cancel] },
          )
        } catch {
          return { drop: 'Keysafe: prompt not sent (the key question was dismissed).' }
        }
      }
      if (pick === cancel) return { drop: 'Keysafe: prompt cancelled; nothing was stored.' }
      if (pick === raw) continue

      const typed = pick === store ? suggested : toEnvName(pick)
      if (!typed) return { drop: `Keysafe: "${pick}" is not a usable name, so the prompt was not sent.` }
      // A typed name that is taken gets a free one beside it; the stored key stays.
      const name = uniqueName(typed, await read($, names))
      if (name !== typed) $.ui.toast(`Keysafe: $${typed} already exists, saved as $${name}`)
      if (!(await saveKey($, name, value))) {
        return { drop: `Keysafe could not write $${name} to ${backend ? BACKEND_LABEL[backend] : 'a secure store'}, so the prompt was not sent.` }
      }
      text = text.split(value).join(`$${name}`)
      stored.push(name)
    }
    if (stored.length > 0) {
      $.ui.toast(`Keysafe: sent ${stored.map(n => `$${n}`).join(', ')} in place of the key`)
    }
    return next({ ...e, text })
  }).catch(($, e, next) =>
    // Fail closed: never let a detected key through unstored.
    next.called || detectKeys(e.text).length === 0
      ? next(e)
      : { drop: 'Keysafe could not store the pasted key, so the prompt was not sent.' },
  )

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const els = $.ui.resolve(e)
    const { Box, Text, Button } = els
    const Input = 'Input' in els ? els.Input : undefined
    const list = await read($, names)
    const name = await read($, draft)
    const note = await read($, notice)
    const where = await read($, storeLabel)
    // Notices carry their tone as a leading mark: ✓ success, ✗ error.
    const tone = note.startsWith('✓') ? 'success' : note.startsWith('✗') ? 'error' : 'subtle'
    const say = (text: string) => void update($, notice, () => text)

    const header = (
      <Box flexDirection="row" justifyContent="space-between">
        <Text bold color="claude">🔒 Keysafe</Text>
        <Text color="subtle">
          {list.length} {list.length === 1 ? 'key' : 'keys'} · {where || 'no secure store'}
        </Text>
      </Box>
    )

    const keys = (
      <Box flexDirection="column" borderStyle="round" borderColor="subtle" paddingX={1} marginTop={1}>
        {list.length === 0 ? (
          <Box flexDirection="column">
            <Text color="subtle">No keys stored yet.</Text>
            <Text color="subtle" italic>Add one below, or paste a key into a prompt.</Text>
          </Box>
        ) : (
          list.map(n => (
            <Box flexDirection="row" justifyContent="space-between">
              <Text>
                <Text color="success">● </Text>
                <Text mono>${n}</Text>
              </Text>
              {Input && (
                <Button
                  key={`rm:${n}`}
                  label="remove"
                  variant="secondary"
                  dimColor
                  onPress={() => void removeKey($, n).then(() => say(`✓ Removed $${n}`))}
                />
              )}
            </Box>
          ))
        )}
      </Box>
    )

    const footer = (
      <Box flexDirection="column" marginTop={1}>
        <Text color="subtle">Claude uses keys as $NAME in Bash.</Text>
        <Text color="subtle">Values never reach the model; output shows [keysafe:NAME].</Text>
      </Box>
    )

    if (!Input) {
      return (
        <Box flexDirection="column" paddingX={2}>
          {header}
          {keys}
          <Text color="subtle" italic>Add keys from the terminal with /keysafe.</Text>
        </Box>
      )
    }

    const env = toEnvName(name)

    if (where === '') {
      return (
        <Box flexDirection="column" paddingX={2}>
          {header}
          {keys}
          <Box flexDirection="column" borderStyle="round" borderColor="warning" paddingX={1} marginTop={1}>
            <Text bold color="warning">No secure store on this machine</Text>
            <Text>Keysafe never keeps keys in plain files, so it can't store any here.</Text>
            <Text color="subtle">Linux: install secret-tool (libsecret-tools) and run a keyring such as GNOME Keyring or KWallet.</Text>
            <Text color="subtle">Windows: needs powershell.exe on PATH.</Text>
          </Box>
          {footer}
        </Box>
      )
    }

    return (
      <Box flexDirection="column" paddingX={2}>
        {header}
        {keys}
        <Box flexDirection="column" borderStyle="round" borderColor="claude" paddingX={1} marginTop={1}>
          <Text bold>Add a key</Text>
          <Input
            key="name"
            label="Name   "
            placeholder="STRIPE_SECRET_KEY"
            value={name}
            submitLabel="next"
            onInput={(v: string) => void update($, draft, () => v)}
            onSubmit={(v: string) => void update($, draft, () => v)}
          />
          {name !== '' && env !== name && (
            <Text color={env ? 'subtle' : 'warning'}>
              {env ? `  saves as $${env}` : '  use letters, digits and _'}
            </Text>
          )}
          <Input
            key="value"
            label="Value  "
            placeholder="paste the key, Enter to save"
            value=""
            submitLabel="save"
            onSubmit={async (v: string) => {
              const secret = v.trim()
              if (!env) return say('✗ Enter a name first (letters, digits, _).')
              if (!secret) return say('✗ The value is empty.')
              if (list.includes(env)) return say(`✗ $${env} already exists. Remove it first or pick another name.`)
              const ok = await saveKey($, env, secret)
              await update($, draft, () => '')
              say(ok ? `✓ Saved $${env}` : `✗ Could not write $${env} to ${where || 'a secure store'}.`)
            }}
          />
        </Box>
        {note !== '' && (
          <Box marginTop={1}>
            <Text color={tone}>{note}</Text>
          </Box>
        )}
        {footer}
      </Box>
    )
  })
}
