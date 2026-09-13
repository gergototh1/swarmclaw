import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { FULL_WIDTH_VIEWS, PANEL_SIDEBAR_VIEWS, VIEW_LABELS } from './view-constants'
import type { AppView } from '@/types'

/**
 * PANEL_SIDEBAR_VIEWS says which views have a panel beside the rail. What a
 * route actually renders is a separate claim, in a separate file, and until
 * this test nothing checked that the two agreed.
 *
 * Both directions of that disagreement have now happened here:
 *
 *   - `stream` and `vault` were once listed as panel views after their route
 *     layouts were dropped, so navigating to either set `sidebarOpen` true
 *     with no panel behind it and leaked the flag into the next view. That is
 *     recorded in view-constants.ts and was fixed by hand.
 *
 *   - `chatrooms`, `missions` and `projects` were listed as FULL_WIDTH while
 *     each rendered a private panel that ignored `sidebarOpen` entirely. The
 *     table was wrong and nothing made it hurt, until those three were moved
 *     onto the shared SidebarPanelShell, which honours the flag. Navigating to
 *     any of them then set the flag false and the panel vanished -- taking the
 *     only way to create a chatroom with it.
 *
 *   - `conversations` (the Chat route, `src/app/chat`) rendered
 *     SidebarPanelShell but was in neither set, so only the rail's own click
 *     handler ever opened the list -- a reload, a bookmark, or the tab host
 *     (no rail at all) landed on a page with no conversation list on it.
 *
 * The second one shipped. It was found by a person opening the page, which is
 * the failure mode this file exists to replace. The third was found the same
 * way.
 */

const HERE = dirname(fileURLToPath(import.meta.url))
const APP_DIR = resolve(HERE, '../../app')

/**
 * The route directory for a view.
 *
 * Views spell compound names with an underscore and routes with a hyphen
 * (`mcp_servers` -> `/mcp-servers`), which is the whole of the mapping --
 * except `conversations`, whose route is `/chat` (VIEW_TO_PATH in
 * navigation.ts), not `/conversations`. VIEW_TO_PATH is the real table but
 * that module is `'use client'` and does not export it; if this ever
 * diverges from that table, the existence assertion below is what fails,
 * loudly, rather than a view being silently skipped.
 */
function routeDir(view: AppView): string {
  if (view === 'conversations') return resolve(APP_DIR, 'chat')
  return resolve(APP_DIR, view.replace(/_/g, '-'))
}

/**
 * The reverse of the above, for the direction the mapping does not already
 * cover: a route directory that renders the panel, and the view (if any) it
 * is supposed to belong to. `chat` is the one directory whose name does not
 * un-hyphenate back to its view (`conversations`); every other panel route
 * reverses cleanly by turning hyphens back into underscores.
 */
const ROUTE_DIR_VIEW_OVERRIDES: Record<string, AppView> = { chat: 'conversations' }

function dirToView(dirName: string): AppView | null {
  const override = ROUTE_DIR_VIEW_OVERRIDES[dirName]
  if (override) return override
  const candidate = dirName.replace(/-/g, '_')
  return candidate in VIEW_LABELS ? (candidate as AppView) : null
}

/** Everything a route renders: its layout and its page, concatenated. */
function routeSource(view: AppView): string | null {
  const dir = routeDir(view)
  if (!fs.existsSync(dir)) return null
  return ['layout.tsx', 'page.tsx']
    .map((f) => (fs.existsSync(resolve(dir, f)) ? fs.readFileSync(resolve(dir, f), 'utf8') : ''))
    .join('\n')
}

test('every panel view has a route that renders the panel', () => {
  const missing: string[] = []
  for (const view of PANEL_SIDEBAR_VIEWS) {
    const source = routeSource(view)
    assert.notEqual(source, null, `PANEL_SIDEBAR_VIEWS lists "${view}" but src/app/${view.replace(/_/g, '-')} does not exist`)
    if (!source!.includes('SidebarPanelShell')) missing.push(view)
  }
  assert.deepEqual(
    missing,
    [],
    'these views are listed as having a panel, but their route renders none. Navigating to one sets sidebarOpen true with nothing behind it, and the flag then leaks into the next panel-backed view the user opens.',
  )
})

test('no full-width view renders a panel', () => {
  const unexpected: string[] = []
  for (const view of FULL_WIDTH_VIEWS) {
    const source = routeSource(view)
    if (source?.includes('SidebarPanelShell')) unexpected.push(view)
  }
  assert.deepEqual(
    unexpected,
    [],
    'these views render a panel but are classified full-width, so navigating to one sets sidebarOpen false and the panel disappears -- along with whatever it is the only way to reach. This is exactly how chatrooms lost its create-a-group button.',
  )
})

test('the two sets are disjoint', () => {
  // A view in both would make the rail's own branch order decide the outcome,
  // which is not a decision anyone would have written down on purpose.
  const both = [...PANEL_SIDEBAR_VIEWS].filter((v) => FULL_WIDTH_VIEWS.has(v))
  assert.deepEqual(both, [])
})

test('every route that renders the panel belongs to a listed panel view', () => {
  // The other two tests above only walk views already in one of the two
  // sets, so a route that renders SidebarPanelShell while its view sits in
  // neither set -- exactly what happened to `conversations` -- was never
  // checked. This test starts from the routes instead and works backward.
  const offenders: string[] = []
  for (const entry of fs.readdirSync(APP_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const dir = resolve(APP_DIR, entry.name)
    const source = ['layout.tsx', 'page.tsx']
      .map((f) => (fs.existsSync(resolve(dir, f)) ? fs.readFileSync(resolve(dir, f), 'utf8') : ''))
      .join('\n')
    if (!source.includes('SidebarPanelShell')) continue
    const view = dirToView(entry.name)
    if (!view) {
      offenders.push(`src/app/${entry.name} renders SidebarPanelShell but does not map to any AppView -- add it to ROUTE_DIR_VIEW_OVERRIDES above`)
      continue
    }
    if (!PANEL_SIDEBAR_VIEWS.has(view)) {
      offenders.push(`src/app/${entry.name} renders SidebarPanelShell for view "${view}", which PANEL_SIDEBAR_VIEWS does not list -- only a rail click, never a reload/bookmark/tab-host open, will ever show it`)
    }
  }
  assert.deepEqual(offenders, [])
})

/**
 * Discrimination proofs. Each mutation was applied to a temp copy of
 * view-constants.ts (or, for #4, this file) and the named test confirmed to
 * fail:
 *
 *   1. move 'chatrooms' back to FULL_WIDTH_VIEWS   breaks "no full-width view renders a panel"
 *   2. add 'stream' to PANEL_SIDEBAR_VIEWS         breaks "every panel view has a route"
 *   3. add 'agents' to FULL_WIDTH_VIEWS            breaks "the two sets are disjoint"
 *   4. remove 'conversations' from PANEL_SIDEBAR_VIEWS   breaks "every route that renders the panel belongs to a listed panel view"
 *
 * (1) is the regression that actually shipped. (4) is the second one.
 */
