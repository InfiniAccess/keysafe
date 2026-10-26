# Keysafe

A Claude Code mod that lets Claude use your API keys without ever seeing them.

- **Store keys in your OS's secure store.** macOS Keychain, the Linux Secret Service (GNOME Keyring / KWallet), or Windows Credential Manager. Never a plain file.
- **Claude uses them by name.** Each key is available in Bash as `$NAME`, read from the store when the command runs, so the value never appears in the command text.
- **Values are redacted.** If a stored value shows up in output or a file, Claude sees `[keysafe:NAME]` instead.
- **Paste guard.** Paste a key into a prompt and Keysafe asks whether to store it and send `$NAME` in its place, send it unchanged, or cancel. Stored keys are never overwritten.

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install keysafe --marketplace InfiniAccess/keysafe
```

Answer `y` to add the marketplace, then pick a scope.

From a shell:

```
claude plugin install keysafe --marketplace InfiniAccess/keysafe
```

## Use

- `/keysafe` opens the pane: your stored key names, a remove button for each, and a form to add one: type the name, press Enter, then paste the value.
- Or paste a key into a prompt and pick **Store as $NAME**.
- Then ask Claude to use it, e.g. "call the Stripe API with `$STRIPE_SECRET_KEY`".

## Requirements

| OS | Store | Needs |
|---|---|---|
| macOS | Keychain | nothing extra |
| Linux | Secret Service | `secret-tool` (`libsecret-tools`) and a running keyring |
| Windows | Credential Manager | `powershell.exe` (built in) |

On Windows, a key is exported only into Bash commands that name it (`$NAME`), since each lookup starts PowerShell.

## Limits

- Redaction catches the exact value only; an encoded copy (e.g. base64) would not be caught.
- The pane's Value field shows what you type while you type it.
- A pasted key may remain in your local prompt history.
