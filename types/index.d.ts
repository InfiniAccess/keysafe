export type KeyName = string

declare module 'claude-code' {
  interface PluginState {
    keysafe: { names: KeyName[]; draft: string; pending: string; notice: string; store: string }
  }
}
