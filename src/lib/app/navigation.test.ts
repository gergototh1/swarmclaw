import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'

let mod: typeof import('@/lib/app/navigation')

before(async () => {
  process.env.SWARMCLAW_BUILD_MODE = '1'
  mod = await import('@/lib/app/navigation')
})

after(() => {
  delete process.env.SWARMCLAW_BUILD_MODE
})

describe('getViewPath', () => {
  it('returns correct path for common views', () => {
    assert.equal(mod.getViewPath('home'), '/home')
    assert.equal(mod.getViewPath('agents'), '/agents')
    assert.equal(mod.getViewPath('mcp_servers'), '/mcp-servers')
    assert.equal(mod.getViewPath('org_chart'), '/org-chart')
  })

  it('appends encoded ID for agents view', () => {
    assert.equal(mod.getViewPath('agents', 'abc-123'), '/agents/abc-123')
  })

  it('appends encoded ID for chatrooms view', () => {
    assert.equal(mod.getViewPath('chatrooms', 'room-1'), '/chatrooms/room-1')
  })

  it('ignores ID for views that do not support it', () => {
    assert.equal(mod.getViewPath('tasks', 'some-id'), '/tasks')
    assert.equal(mod.getViewPath('settings', 'x'), '/settings')
  })

  it('encodes special characters in ID', () => {
    assert.equal(mod.getViewPath('agents', 'foo/bar'), '/agents/foo%2Fbar')
    assert.equal(mod.getViewPath('chatrooms', 'a b&c'), '/chatrooms/a%20b%26c')
  })
})

describe('pathToView', () => {
  it('matches exact path', () => {
    assert.equal(mod.pathToView('/agents'), 'agents')
    assert.equal(mod.pathToView('/settings'), 'settings')
  })

  it('matches path prefix with trailing segment', () => {
    assert.equal(mod.pathToView('/agents/123'), 'agents')
    assert.equal(mod.pathToView('/missions/m-1/details'), 'missions')
  })

  it('returns null for unknown paths', () => {
    assert.equal(mod.pathToView('/unknown'), null)
    assert.equal(mod.pathToView('/agent'), null)
  })

  it('resolves the merged /stream route to its AppView', () => {
    // /stream absorbed /runs, /activity and /logs and is now the AppView for
    // all three. This only pins pathToView's own behavior — it says nothing
    // about what the sidebar rail renders; see resolveSidebarActiveView below
    // for the test that actually covers the rail.
    assert.equal(mod.pathToView('/stream'), 'stream')
  })

  it('returns null for empty string', () => {
    assert.equal(mod.pathToView(''), null)
  })
})

describe('resolveSidebarActiveView', () => {
  it('resolves known views so the happy path stays pinned', () => {
    assert.equal(mod.resolveSidebarActiveView('/agents'), 'agents')
    assert.equal(mod.resolveSidebarActiveView('/agents/abc-123'), 'agents')
    assert.equal(mod.resolveSidebarActiveView('/settings'), 'settings')
  })

  it('resolves /stream to the stream AppView so it highlights in the rail', () => {
    // /stream absorbed /runs, /activity and /logs and now names its own
    // AppView. This is the exact case the sidebar rail regressed on before
    // 'stream' existed: a `?? 'home'` fallback here would have lit up the
    // Home nav entry on every visit to /stream.
    assert.equal(mod.resolveSidebarActiveView('/stream'), 'stream')
  })

  it('returns null, not "home", for an in-app path the view table does not know', () => {
    // A route that genuinely has no AppView yet (an extension page, or any
    // future in-app route not in VIEW_TO_PATH) must resolve to null. A
    // `?? 'home'` fallback here would light up the Home nav entry on every
    // visit to such a route.
    assert.equal(mod.resolveSidebarActiveView('/some-future-route'), null)
  })

  it('returns null for an extension page path', () => {
    assert.equal(mod.resolveSidebarActiveView('/x/some-extension'), null)
  })

  it('returns null for a genuinely unknown path', () => {
    assert.equal(mod.resolveSidebarActiveView('/totally-made-up'), null)
  })
})
