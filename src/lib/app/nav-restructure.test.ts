import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * The 2026-09-16 navigation split, pinned: chat with an agent lives only under
 * /chat, agent settings only under /agents, tasks only on the board. Each
 * assertion names the file that would silently bring the old shape back.
 */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8')

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(full, out)
    else if (/\.tsx?$/.test(entry.name) && !entry.name.includes('.test.')) out.push(full)
  }
  return out
}

describe('navigation split', () => {
  it('no code opens the removed agent sheet', () => {
    const offenders = walk(path.join(ROOT, 'src'))
      .filter((f) => /\b(setAgentSheetOpen|agentSheetOpen|setEditingAgentId)\b/.test(fs.readFileSync(f, 'utf8')))
      .map((f) => path.relative(ROOT, f))
    assert.deepEqual(offenders, [])
  })

  it('the agents route renders settings, not a chat', () => {
    assert.doesNotMatch(read('src/app/agents/[id]/page.tsx'), /ChatArea/)
    assert.doesNotMatch(read('src/app/agents/layout.tsx'), /AgentChatList/)
    assert.ok(fs.existsSync(path.join(ROOT, 'src/app/agents/new/page.tsx')))
  })

  it('the chat page offers both lists', () => {
    const layout = read('src/app/chat/layout.tsx')
    assert.match(layout, /AgentChatList/)
    assert.match(layout, /ConversationList/)
  })

  it('the tasks route has no side list', () => {
    assert.doesNotMatch(read('src/app/tasks/layout.tsx'), /SidebarPanelShell/)
  })

  it('a navigate from the tab host asks the leave guard first', () => {
    const bridge = read('src/components/layout/tab-frame-bridge.tsx')
    assert.match(bridge, /requestLeave\(\(\) => \{[\s\S]*?router\.push\(message\.href\)[\s\S]*?\}\)/)
  })

  it('a guarded rail click does not ask the guard twice', () => {
    const rail = read('src/components/layout/sidebar-rail.tsx')
    assert.doesNotMatch(rail, /useNavigate\(\)/)
    assert.doesNotMatch(rail, /requestLeave\(\(\) => navigateTo/)
  })

  it('the editor drops its guard before running a confirmed leave, and never blocks the desktop app', () => {
    const editor = read('src/components/agents/agent-editor.tsx')
    assert.match(editor, /releaseLeaveGuardRef\.current\?\.\(\)[\s\S]{0,80}go\?\.\(\)/)
    assert.match(editor, /if \(warnOnUnload\) window\.addEventListener\('beforeunload'/)
  })

  it('the rail header has no default-agent shortcut', () => {
    assert.doesNotMatch(read('src/components/layout/sidebar-rail.tsx'), /goToDefaultChat|Default shortcut/)
  })
})
