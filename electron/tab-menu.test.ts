import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
// Tests are outside the desktop build (electron/tsconfig.json excludes them),
// so this one may reach into src for the renderer's validator.
import { parseTabCommand } from '../src/lib/app/tab-protocol'
import { TAB_COMMAND_CHANNEL, tabMenuEntries } from './tab-menu'

describe('tabMenuEntries', () => {
  it('uses Cmd on a Mac and Ctrl elsewhere', () => {
    assert.ok(tabMenuEntries(true).some((e) => e.accelerator === 'Cmd+T'))
    assert.ok(tabMenuEntries(false).some((e) => e.accelerator === 'Ctrl+T'))
  })

  it('has one entry per shortcut, with no accelerator used twice', () => {
    const accelerators = tabMenuEntries(true).map((e) => e.accelerator)
    assert.equal(new Set(accelerators).size, accelerators.length)
  })

  it('maps close to Cmd+W, reopen to Shift+Cmd+T, and 1..9 to positions', () => {
    const entries = tabMenuEntries(true)
    assert.deepEqual(entries.find((e) => e.accelerator === 'Cmd+W')?.command, { kind: 'close' })
    assert.deepEqual(entries.find((e) => e.accelerator === 'Shift+Cmd+T')?.command, { kind: 'reopen' })
    assert.deepEqual(entries.find((e) => e.accelerator === 'Cmd+9')?.command, { kind: 'goto', position: 9 })
    assert.equal(entries.filter((e) => e.command.kind === 'goto').length, 9)
  })

  it('sends only commands the renderer accepts, on every platform', () => {
    for (const isMac of [true, false]) {
      for (const entry of tabMenuEntries(isMac)) {
        assert.deepEqual(parseTabCommand(entry.command), entry.command, `${entry.label} (${isMac ? 'mac' : 'other'})`)
      }
    }
  })

  it('names the IPC channel the preload listens on', () => {
    assert.equal(TAB_COMMAND_CHANNEL, 'swarmclaw:tab-command')
  })
})
