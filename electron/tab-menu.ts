/**
 * The tab shortcuts of the desktop app, as data.
 *
 * The browser keeps Cmd+T, Cmd+W and Ctrl+Tab for itself, so the web app uses
 * Option-based keys; in the desktop app the menu can take the familiar ones.
 * The renderer receives each as a command on `TAB_COMMAND_CHANNEL` and
 * validates it (`parseTabCommand` in `src/lib/app/tab-protocol.ts`), whose
 * shapes these repeat because this directory cannot import from `src`.
 */

export const TAB_COMMAND_CHANNEL = 'swarmclaw:tab-command'

export type DesktopTabCommand =
  | { kind: 'new' }
  | { kind: 'close' }
  | { kind: 'reopen' }
  | { kind: 'next' }
  | { kind: 'previous' }
  | { kind: 'goto'; position: number }

export interface TabMenuEntry {
  label: string
  accelerator: string
  command: DesktopTabCommand
}

export function tabMenuEntries(isMac: boolean): TabMenuEntry[] {
  const mod = isMac ? 'Cmd' : 'Ctrl'
  const entries: TabMenuEntry[] = [
    { label: 'New Tab', accelerator: `${mod}+T`, command: { kind: 'new' } },
    { label: 'Close Tab', accelerator: `${mod}+W`, command: { kind: 'close' } },
    { label: 'Reopen Closed Tab', accelerator: `Shift+${mod}+T`, command: { kind: 'reopen' } },
    { label: 'Next Tab', accelerator: 'Ctrl+Tab', command: { kind: 'next' } },
    { label: 'Previous Tab', accelerator: 'Ctrl+Shift+Tab', command: { kind: 'previous' } },
  ]
  for (let position = 1; position <= 9; position++) {
    entries.push({
      label: position === 9 ? 'Last Tab' : `Tab ${position}`,
      accelerator: `${mod}+${position}`,
      command: { kind: 'goto', position },
    })
  }
  return entries
}
