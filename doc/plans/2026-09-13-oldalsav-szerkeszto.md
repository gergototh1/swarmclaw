# Rail editor (Phase 3) — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The operator decides what the rail shows and where: pin entries above the sections, hide entries or whole sections, move entries between sections, reorder entries and sections — edited in place on the rail, saved on the server, the same in the browser and the desktop app.

**Architecture:** `appSettings.railLayout` holds the operator's arrangement; `undefined` is today's rail. One pure resolver turns the static table (`NAV_SECTIONS`), the installed extension pages and the stored layout into the rail to render; a second pure module turns each edit into the next layout. The server validates the field with the same zod schema. The rail renders the resolved rail, and an edit mode replaces its lists with editable rows (native HTML5 drag and drop plus a keyboard-reachable ⋯ menu). A `VIEW_ICONS` table gives every view its own icon for pinned rows and tabs, and the ⌘K palette lists every view so a hidden entry stays reachable.

**Tech Stack:** Next 16 App Router, React 19, TypeScript, zustand, zod 4, radix `DropdownMenu`, lucide-react, `node:test` + `tsx`.

**Spec:** `doc/specs/2026-09-11-fulek-es-oldalsav-szerkeszto-design.md`, section "3. Oldalsáv-szerkesztő", plus section 5 (tests) and 6 (delivery). Phases 1 and 2 are merged (`main` = `10886950`).

## Decisions this plan makes beyond the spec

1. **`RailItemRef` stores the view part as a string** (`view:${string}`), not `view:${AppView}`: a view removed in a later release must stay a harmless stored reference, the same rule the spec gives an uninstalled extension page. The schema still checks the shape (`view:[a-z_]+`, `page:<ext>/<page>`, `section:<NavSectionId>`).
2. **Direct sections (Home, Chat) have no entries**, exactly as today. An extension page that declares `section: 'home'` or `'conversations'` stays unlisted, as it is today (the current rail never renders a list under a direct section).
3. **The Settings footer section is fixed completely**: not hidden, not moved, its entries neither moved out, pinned, hidden, nor reordered; nothing else can be moved into it.
4. **Editing is optimistic**: the store writes the new layout at once, then `PUT /settings { railLayout }`. Only the newest write's answer is applied; a failed write puts back the layout from before it and the editor shows a toast.
5. **UI copy is English**, like the rest of the rail ("Customize", "Done", "Reset", "Pinned", "Fixed").
6. **`SECTION_ICONS` moves to its own file** (`src/components/layout/section-icons.tsx`) so the editor and the tab strip can import it without importing the rail.
7. **The rail's "you are here" section follows the resolved layout**: a page moved to Operations opens and lights Operations; a pinned entry lights its own row and no section.
8. A section's leading run of extension pages keeps today's hairline below it; once the operator mixes the order, the hairline sits after the leading run of pages, if any.

## Global Constraints

- Data model, verbatim from the spec: `appSettings.railLayout` — server side, so the desktop app and the browser see the same. `undefined` = the default rail. `interface RailLayout { version: 1; pinned: RailItemRef[]; sectionOrder: NavSectionId[]; sections: Partial<Record<NavSectionId, RailItemRef[]>>; hidden: (RailItemRef | \`section:${NavSectionId}\`)[] }`.
- Resolution rules, verbatim: an operator-placed entry goes where it was put, in that order; a pinned entry leaves its section and shows above the sections; an entry the layout does not mention goes to the end of its default section — nothing may disappear; a reference to something that no longer exists is not rendered but stays in the stored layout; direct sections (Home, Chat) can be reordered and hidden as rows and have no entries; the Settings (footer) section is fixed.
- Every change saves immediately (`updateSettings`-style, optimistic). No Cancel. "Reset" after confirmation writes `railLayout: null`.
- Editing only in the desktop layout; the mobile drawer shows the same resolved layout.
- A hidden entry stays reachable with ⌘K.
- `PUT /settings` validates `railLayout` with the zod schema; an invalid shape is not written (400 naming the field). The client reads the stored value defensively.
- No new dependencies. Drag and drop is native HTML5, like `src/components/tasks/task-card.tsx`.
- No `any`. Never disable or suppress a lint rule. `npm run lint:baseline` must pass. No `!` non-null assertions in new code.
- Module-level mutable state uses `hmrSingleton` from `@/lib/shared-utils`. Local store mutations call `invalidateFingerprint('appSettings')`; loader writes use `setIfChanged`.
- `CLAUDE.md` and `AGENTS.md` stay in sync. `AGENTS.md` is untracked and absent in this worktree: change only `CLAUDE.md` and note it in your report (the controller copies it at merge).
- TS target is ES2017: do not use `Array.prototype.at` or `Object.fromEntries` in new code.
- Do NOT start, stop or restart any server (ports 3456, 3457, 3901 are in use). Do not run the whole `npm run test:runtime`. Run the test files each task names with `npx tsx --test <files>`, plus `npx tsc --noEmit -p .` and `npx eslint <changed files>`.
- Every commit message ends with:
  ```
  Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_013wE44gRcx8yMbNmXZyGJZL
  ```

## File structure

| File | Responsibility |
|---|---|
| `src/lib/app/rail-layout.ts` (new) | `RailLayout` type and zod schema, `readRailLayout`, refs, `resolveRailLayout`, `materializeLayout`, `routeSectionInRail`. Pure, server-safe. |
| `src/lib/app/rail-layout-edit.ts` (new) | Edit operations: move / move by one / pin / hide / move section. Pure. |
| `src/lib/app/view-icons.ts` (new) | `VIEW_ICONS: Record<AppView, ViewIconName>`. Pure. |
| `src/components/layout/view-icon.tsx` (new) | `ViewIcon` component (lucide map). |
| `src/components/layout/section-icons.tsx` (new) | `SECTION_ICONS` moved out of the rail. |
| `src/lib/app/palette-views.ts` (new) | Every rail view as a ⌘K destination. Pure. |
| `src/components/layout/rail-editor.tsx` (new) | Edit mode of the rail. |
| `src/app/api/settings/route.ts` | Validate `railLayout`, `null` clears it. |
| `src/types/app-settings.ts` | `railLayout?: RailLayout \| null`. |
| `src/stores/slices/data-slice.ts` | `updateRailLayout` (optimistic, newest write wins). |
| `src/components/layout/sidebar-rail.tsx` | Render the resolved rail, pinned rows, "Customize" entry to edit mode. |
| `src/components/layout/extension-nav-items.tsx` | Drop `ExtensionPagesForSection` (the rail renders pages from the resolved rail). |
| `src/lib/app/tab-label.ts`, `src/components/layout/tab-strip.tsx` | Tabs show the view icon. |
| `src/components/shared/command-palette.tsx` | Palette lists every rail view. |

---

### Task 1: Rail layout model, schema and resolver

**Files:**
- Create: `src/lib/app/rail-layout.ts`
- Create: `src/lib/app/rail-layout.test.ts`
- Modify: `src/lib/app/nav-sections.test.ts` (completeness over layouts)
- Modify: `package.json` (`test:runtime` registers the new test file)

**Interfaces:**
- Consumes: `NAV_SECTIONS`, `NAV_SECTION_IDS`, `NavSection`, `NavSectionId` (`src/lib/app/nav-sections.ts`); `resolvePageSection`, `resolvePageOrder` (`src/lib/extension-page-nav.ts`); `AppView` (`@/types`).
- Produces (later tasks rely on these exact names):
  - `type RailItemRef = \`view:${string}\` | \`page:${string}/${string}\``
  - `type RailHiddenRef = RailItemRef | \`section:${string}\``
  - `const RailLayoutSchema`, `type RailLayout = z.infer<typeof RailLayoutSchema>`, `const MAX_RAIL_REFS = 500`
  - `function isRailItemRef(value: unknown): value is RailItemRef`
  - `function readRailLayout(value: unknown): RailLayout | null`
  - `interface RailPage { extensionId: string; id: string; label: string; path: string; icon?: string; section?: string; order?: number }`
  - `type RailTarget = { kind: 'view'; view: AppView } | { kind: 'page'; page: RailPage }`
  - `interface RailEntry { ref: RailItemRef; home: NavSectionId | null; target: RailTarget | null; hidden: boolean }`
  - `interface RailSectionEntry { section: NavSection; entries: RailEntry[]; hidden: boolean; fixed: boolean }`
  - `interface ResolvedRail { pinned: RailEntry[]; sections: RailSectionEntry[]; footer: RailSectionEntry[] }`
  - `function viewRef(view: AppView): RailItemRef`, `function pageRef(page: Pick<RailPage, 'extensionId' | 'id'>): RailItemRef`, `function sectionRef(id: NavSectionId): RailHiddenRef`
  - `function resolveRailLayout(navSections: readonly NavSection[], pages: readonly RailPage[], layout: RailLayout | null | undefined): ResolvedRail`
  - `function materializeLayout(rail: ResolvedRail, previous: RailLayout | null | undefined): RailLayout`
  - `interface RailRouteMatch { section: NavSectionId | null; pinnedRef: RailItemRef | null }`, `function routeSectionInRail(rail: ResolvedRail, pathname: string, view: AppView | null): RailRouteMatch | null`

- [ ] **Step 1: Write the failing tests**

Create `src/lib/app/rail-layout.test.ts`:

```ts
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { NAV_SECTIONS } from './nav-sections'
import {
  materializeLayout,
  RailLayoutSchema,
  readRailLayout,
  resolveRailLayout,
  routeSectionInRail,
  type RailLayout,
  type RailPage,
  type ResolvedRail,
} from './rail-layout'

const PAGES: RailPage[] = [
  { extensionId: 'crm', id: 'crm', label: 'CRM', path: '/x/crm', icon: 'Users', section: 'work', order: 10 },
  { extensionId: 'docs', id: 'docs', label: 'Docs', path: '/x/docs', icon: 'FileText', section: 'knowledge' },
]

function layout(patch: Partial<RailLayout>): RailLayout {
  return { version: 1, pinned: [], sectionOrder: [], sections: {}, hidden: [], ...patch }
}

function sectionOf(rail: ResolvedRail, id: string) {
  const found = [...rail.sections, ...rail.footer].find((s) => s.section.id === id)
  assert.ok(found, `no section ${id}`)
  return found
}

const refsOf = (rail: ResolvedRail, id: string) => sectionOf(rail, id).entries.map((e) => e.ref)

describe('resolveRailLayout', () => {
  it('without a layout reproduces the default rail: table order, extension pages first', () => {
    const rail = resolveRailLayout(NAV_SECTIONS, PAGES, undefined)
    assert.deepEqual(rail.sections.map((s) => s.section.id), ['home', 'conversations', 'chat', 'work', 'knowledge', 'connect', 'operations'])
    assert.deepEqual(refsOf(rail, 'work'), ['page:crm/crm', 'view:tasks', 'view:missions', 'view:schedules', 'view:projects'])
    assert.deepEqual(refsOf(rail, 'knowledge'), ['page:docs/docs', 'view:memory', 'view:knowledge', 'view:skills'])
    assert.deepEqual(refsOf(rail, 'home'), [])
    assert.deepEqual(rail.footer.map((s) => s.entries.map((e) => e.ref)), [['view:settings', 'view:vault']])
    assert.deepEqual(rail.pinned, [])
    assert.ok(rail.sections.every((s) => !s.hidden && !s.fixed))
    assert.equal(sectionOf(rail, 'settings').fixed, true)
  })

  it('puts an entry where the layout placed it, in that order', () => {
    const rail = resolveRailLayout(NAV_SECTIONS, PAGES, layout({ sections: { operations: ['page:docs/docs', 'view:stream'] } }))
    assert.deepEqual(refsOf(rail, 'operations'), ['page:docs/docs', 'view:stream', 'view:usage', 'view:quality', 'view:autonomy'])
    assert.deepEqual(refsOf(rail, 'knowledge'), ['view:memory', 'view:knowledge', 'view:skills'])
  })

  it('takes a pinned entry out of its section', () => {
    const rail = resolveRailLayout(NAV_SECTIONS, PAGES, layout({ pinned: ['page:crm/crm', 'view:agents'] }))
    assert.deepEqual(rail.pinned.map((e) => e.ref), ['page:crm/crm', 'view:agents'])
    assert.equal(refsOf(rail, 'work').includes('page:crm/crm'), false)
    assert.equal(refsOf(rail, 'chat').includes('view:agents'), false)
    assert.deepEqual(rail.pinned.map((e) => e.home), ['work', 'chat'])
  })

  it('appends an entry the layout never mentions to the end of its default section', () => {
    // Stored before the CRM page existed: CRM lands after the stored order.
    const rail = resolveRailLayout(NAV_SECTIONS, PAGES, layout({ sections: { work: ['view:projects', 'view:tasks', 'view:missions', 'view:schedules'] } }))
    assert.deepEqual(refsOf(rail, 'work'), ['view:projects', 'view:tasks', 'view:missions', 'view:schedules', 'page:crm/crm'])
  })

  it('an earlier section cannot take back an entry a later section placed', () => {
    // Work comes before Operations, and Work's default holds Tasks; the layout put Tasks in Operations.
    const rail = resolveRailLayout(NAV_SECTIONS, PAGES, layout({ sections: { operations: ['view:tasks'] } }))
    assert.equal(refsOf(rail, 'work').includes('view:tasks'), false)
    assert.deepEqual(refsOf(rail, 'operations').slice(0, 1), ['view:tasks'])
  })

  it('keeps an uninstalled page in place without a target, and materializes it back', () => {
    const stored = layout({ pinned: ['page:gone/page'], sections: { work: ['view:tasks', 'page:video/video', 'view:missions'] } })
    const rail = resolveRailLayout(NAV_SECTIONS, PAGES, stored)
    assert.deepEqual(
      sectionOf(rail, 'work').entries.map((e) => [e.ref, e.target !== null]),
      [['view:tasks', true], ['page:video/video', false], ['view:missions', true], ['page:crm/crm', true], ['view:schedules', true], ['view:projects', true]],
    )
    assert.deepEqual(rail.pinned.map((e) => [e.ref, e.target, e.home]), [['page:gone/page', null, null]])
    const again = materializeLayout(rail, stored)
    assert.deepEqual(again.sections.work, ['view:tasks', 'page:video/video', 'view:missions', 'page:crm/crm', 'view:schedules', 'view:projects'])
    assert.deepEqual(again.pinned, ['page:gone/page'])
  })

  it('marks hidden entries and sections, but never the fixed Settings section or its entries', () => {
    const rail = resolveRailLayout(NAV_SECTIONS, PAGES, layout({ hidden: ['view:protocols', 'section:connect', 'section:settings', 'view:vault'] }))
    assert.equal(sectionOf(rail, 'chat').entries.find((e) => e.ref === 'view:protocols')?.hidden, true)
    assert.equal(sectionOf(rail, 'connect').hidden, true)
    assert.equal(sectionOf(rail, 'settings').hidden, false)
    assert.equal(sectionOf(rail, 'settings').entries.find((e) => e.ref === 'view:vault')?.hidden, false)
  })

  it('never lets a Settings entry leave its section, nor anything enter it', () => {
    const rail = resolveRailLayout(NAV_SECTIONS, PAGES, layout({ pinned: ['view:settings'], sections: { work: ['view:vault'], settings: ['view:tasks'] } }))
    assert.deepEqual(rail.pinned, [])
    assert.deepEqual(refsOf(rail, 'settings'), ['view:settings', 'view:vault'])
    assert.equal(refsOf(rail, 'work').includes('view:vault'), false)
    assert.equal(refsOf(rail, 'work').includes('view:tasks'), true)
  })

  it('orders sections by the layout, ignoring repeated and footer ids, and appends the rest', () => {
    const rail = resolveRailLayout(NAV_SECTIONS, PAGES, layout({ sectionOrder: ['work', 'settings', 'work', 'home'] }))
    assert.deepEqual(rail.sections.map((s) => s.section.id), ['work', 'home', 'conversations', 'chat', 'knowledge', 'connect', 'operations'])
  })

  it('gives direct sections no entries even when the layout lists some', () => {
    const rail = resolveRailLayout(NAV_SECTIONS, PAGES, layout({ sections: { home: ['view:tasks'] } }))
    assert.deepEqual(refsOf(rail, 'home'), [])
    assert.equal(refsOf(rail, 'work').includes('view:tasks'), true)
  })

  it('round-trips through materializeLayout', () => {
    const stored = layout({ pinned: ['view:agents'], sectionOrder: ['operations'], sections: { knowledge: ['view:skills'] }, hidden: ['section:connect', 'view:usage'] })
    const rail = resolveRailLayout(NAV_SECTIONS, PAGES, stored)
    assert.deepEqual(resolveRailLayout(NAV_SECTIONS, PAGES, materializeLayout(rail, stored)), rail)
  })

  it('keeps a hidden reference to an uninstalled page that was never placed', () => {
    const stored = layout({ hidden: ['page:gone/page'] })
    const rail = resolveRailLayout(NAV_SECTIONS, PAGES, stored)
    assert.ok(materializeLayout(rail, stored).hidden.includes('page:gone/page'))
  })
})

describe('routeSectionInRail', () => {
  it('follows an entry to the section it was moved to', () => {
    const rail = resolveRailLayout(NAV_SECTIONS, PAGES, layout({ sections: { operations: ['page:docs/docs'] } }))
    assert.deepEqual(routeSectionInRail(rail, '/x/docs/doc_1', null), { section: 'operations', pinnedRef: null })
    assert.deepEqual(routeSectionInRail(rail, '/tasks', 'tasks'), { section: 'work', pinnedRef: null })
  })

  it('reports a pinned entry instead of a section', () => {
    const rail = resolveRailLayout(NAV_SECTIONS, PAGES, layout({ pinned: ['page:crm/crm'] }))
    assert.deepEqual(routeSectionInRail(rail, '/x/crm/ugyfelek', null), { section: null, pinnedRef: 'page:crm/crm' })
  })

  it('returns null for a route no entry owns', () => {
    const rail = resolveRailLayout(NAV_SECTIONS, PAGES, undefined)
    assert.equal(routeSectionInRail(rail, '/home', 'home'), null)
  })
})

describe('RailLayoutSchema', () => {
  it('accepts a well-formed layout', () => {
    const value = layout({ pinned: ['view:tasks', 'page:crm/crm'], sectionOrder: ['work'], sections: { work: ['view:projects'] }, hidden: ['section:connect', 'view:usage'] })
    assert.equal(RailLayoutSchema.safeParse(value).success, true)
  })

  it('rejects wrong shapes', () => {
    const bad: unknown[] = [
      { ...layout({}), version: 2 },
      { ...layout({}), pinned: ['tasks'] },
      { ...layout({}), pinned: ['page:crm'] },
      { ...layout({}), sectionOrder: ['bogus'] },
      { ...layout({}), sections: { bogus: [] } },
      { ...layout({}), hidden: ['section:bogus'] },
      { ...layout({}), pinned: Array.from({ length: 501 }, (_, i) => `page:e/p${i}`) },
      { pinned: [] },
      null,
    ]
    for (const value of bad) {
      assert.equal(RailLayoutSchema.safeParse(value).success, false, String(JSON.stringify(value)).slice(0, 80))
    }
  })

  it('readRailLayout returns null for anything the schema refuses', () => {
    assert.equal(readRailLayout({ version: 1 }), null)
    assert.equal(readRailLayout(undefined), null)
    assert.deepEqual(readRailLayout(layout({})), layout({}))
  })
})
```

Append this test inside the `describe('nav section table', ...)` block of `src/lib/app/nav-sections.test.ts`, and add `import { resolveRailLayout, type RailLayout } from './rail-layout'` to its imports:

```ts
  // The spec's completeness rule reaches the rail editor too: whatever the
  // operator stored, every listed view is still somewhere in the rail.
  it('keeps every listed view in the rail exactly once, whatever the stored layout says', () => {
    const listed = NAV_SECTIONS.flatMap((s) => (s.direct ? [] : s.views)).map((v) => `view:${v}`).sort()
    const layouts: (RailLayout | null)[] = [
      null,
      { version: 1, pinned: [], sectionOrder: [], sections: {}, hidden: [] },
      {
        version: 1,
        pinned: ['view:tasks', 'view:tasks', 'view:settings'],
        sectionOrder: ['operations', 'work'],
        sections: { work: ['view:agents', 'view:vault'], chat: ['view:agents', 'view:nope'] },
        hidden: ['section:settings'],
      },
    ]
    for (const layout of layouts) {
      const rail = resolveRailLayout(NAV_SECTIONS, [], layout)
      const refs = [...rail.pinned, ...rail.sections.flatMap((s) => s.entries), ...rail.footer.flatMap((s) => s.entries)]
        .filter((e) => e.target !== null)
        .map((e) => e.ref)
      assert.deepEqual([...refs].sort(), listed, JSON.stringify(layout))
      assert.equal(new Set(refs).size, refs.length, 'an entry is listed twice')
    }
  })
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx tsx --test src/lib/app/rail-layout.test.ts src/lib/app/nav-sections.test.ts`
Expected: FAIL — `Cannot find module './rail-layout'`.

- [ ] **Step 3: Implement `src/lib/app/rail-layout.ts`**

```ts
import { z } from 'zod'
import { NAV_SECTION_IDS, type NavSection, type NavSectionId } from '@/lib/app/nav-sections'
import { resolvePageOrder, resolvePageSection } from '@/lib/extension-page-nav'
import type { AppView } from '@/types'

/**
 * The operator's own arrangement of the rail, and how it meets the static table.
 *
 * `NAV_SECTIONS` stays the single source of what exists and where it belongs by
 * default; a stored `RailLayout` only records departures from it. That split is
 * what lets a new view or a newly installed extension page appear without the
 * operator doing anything (it lands at the end of its default section), and an
 * uninstalled one vanish from the rail while keeping its place in the stored
 * layout for the day it comes back.
 *
 * Pure and server-safe: the settings route validates writes with the same
 * schema the rail reads with.
 */

/** `view:<AppView>` or `page:<extensionId>/<pageId>`. The view part is a string so a removed view stays a harmless stored reference. */
export type RailItemRef = `view:${string}` | `page:${string}/${string}`
/** An entry, or a whole section (`section:<NavSectionId>`). */
export type RailHiddenRef = RailItemRef | `section:${string}`

export const MAX_RAIL_REFS = 500

const VIEW_REF = /^view:[a-z_]+$/
const PAGE_REF = /^page:[^/\s]+\/[^/\s]+$/
const SECTION_REF_PREFIX = 'section:'

function isNavSectionId(value: string): value is NavSectionId {
  return (NAV_SECTION_IDS as readonly string[]).includes(value)
}

export function isRailItemRef(value: unknown): value is RailItemRef {
  return typeof value === 'string' && (VIEW_REF.test(value) || PAGE_REF.test(value))
}

function isRailHiddenRef(value: unknown): value is RailHiddenRef {
  if (isRailItemRef(value)) return true
  return typeof value === 'string' && value.startsWith(SECTION_REF_PREFIX) && isNavSectionId(value.slice(SECTION_REF_PREFIX.length))
}

const RailItemRefSchema = z.custom<RailItemRef>(isRailItemRef, { message: 'Expected view:<view> or page:<extension>/<page>' })
const RailHiddenRefSchema = z.custom<RailHiddenRef>(isRailHiddenRef, { message: 'Expected an entry reference or section:<section>' })
const NavSectionIdSchema = z.custom<NavSectionId>((value) => typeof value === 'string' && isNavSectionId(value), { message: 'Unknown section' })

export const RailLayoutSchema = z.object({
  version: z.literal(1),
  pinned: z.array(RailItemRefSchema).max(MAX_RAIL_REFS),
  sectionOrder: z.array(NavSectionIdSchema).max(NAV_SECTION_IDS.length * 2),
  sections: z
    .record(z.string(), z.array(RailItemRefSchema).max(MAX_RAIL_REFS))
    .refine((sections) => Object.keys(sections).every(isNavSectionId), { message: 'Unknown section' }),
  hidden: z.array(RailHiddenRefSchema).max(MAX_RAIL_REFS),
})

export type RailLayout = z.infer<typeof RailLayoutSchema>

/** The stored value, or null when it is missing or not a layout this version understands. */
export function readRailLayout(value: unknown): RailLayout | null {
  const parsed = RailLayoutSchema.safeParse(value)
  return parsed.success ? parsed.data : null
}

/** The part of an extension page declaration the rail needs. `ExtensionPage` satisfies it. */
export interface RailPage {
  extensionId: string
  id: string
  label: string
  path: string
  icon?: string
  section?: string
  order?: number
}

export type RailTarget = { kind: 'view'; view: AppView } | { kind: 'page'; page: RailPage }

export interface RailEntry {
  ref: RailItemRef
  /** The section the entry belongs to by default; null for a reference to something that no longer exists. */
  home: NavSectionId | null
  /** What the entry opens; null when it no longer exists (not rendered, kept in the stored layout). */
  target: RailTarget | null
  hidden: boolean
}

export interface RailSectionEntry {
  section: NavSection
  entries: RailEntry[]
  hidden: boolean
  /** The footer (Settings): never hidden, moved or edited. */
  fixed: boolean
}

export interface ResolvedRail {
  pinned: RailEntry[]
  /** The main run, in the operator's order. */
  sections: RailSectionEntry[]
  footer: RailSectionEntry[]
}

export function viewRef(view: AppView): RailItemRef {
  return `view:${view}`
}

export function pageRef(page: Pick<RailPage, 'extensionId' | 'id'>): RailItemRef {
  return `page:${page.extensionId}/${page.id}`
}

export function sectionRef(id: NavSectionId): RailHiddenRef {
  return `section:${id}`
}

/** A section's extension pages in their declared order — the same order the rail has always used. */
function sectionPages(pages: readonly RailPage[], section: NavSectionId): RailPage[] {
  return pages
    .filter((p) => resolvePageSection(p) === section)
    .sort((a, b) => resolvePageOrder(a) - resolvePageOrder(b) || a.label.localeCompare(b.label))
}

export function resolveRailLayout(
  navSections: readonly NavSection[],
  pages: readonly RailPage[],
  layout: RailLayout | null | undefined,
): ResolvedRail {
  // What exists, where it belongs by default, and in which default order.
  const known = new Map<RailItemRef, { target: RailTarget; home: NavSectionId }>()
  const defaults = new Map<NavSectionId, RailItemRef[]>()
  for (const section of navSections) {
    const refs: RailItemRef[] = []
    if (!section.direct) {
      for (const page of sectionPages(pages, section.id)) {
        const ref = pageRef(page)
        if (known.has(ref)) continue
        known.set(ref, { target: { kind: 'page', page }, home: section.id })
        refs.push(ref)
      }
      for (const view of section.views) {
        const ref = viewRef(view)
        known.set(ref, { target: { kind: 'view', view }, home: section.id })
        refs.push(ref)
      }
    }
    defaults.set(section.id, refs)
  }

  const fixed = new Set(navSections.filter((s) => s.footer).map((s) => s.id))
  const hidden = new Set<string>(layout?.hidden ?? [])
  // A reference to something unknown is movable: it keeps whatever place the operator gave it.
  const movable = (ref: RailItemRef) => {
    const home = known.get(ref)?.home
    return home === undefined || !fixed.has(home)
  }
  const placed = new Set<RailItemRef>()
  const claim = (refs: readonly RailItemRef[] | undefined): RailItemRef[] => {
    const claimed: RailItemRef[] = []
    for (const ref of refs ?? []) {
      if (placed.has(ref) || !movable(ref)) continue
      placed.add(ref)
      claimed.push(ref)
    }
    return claimed
  }
  const entry = (ref: RailItemRef): RailEntry => {
    const item = known.get(ref)
    return { ref, home: item?.home ?? null, target: item?.target ?? null, hidden: movable(ref) && hidden.has(ref) }
  }

  const pinned = claim(layout?.pinned).map(entry)

  const listSections = navSections.filter((s) => !s.footer)
  const ordered: NavSection[] = []
  for (const id of layout?.sectionOrder ?? []) {
    const section = listSections.find((s) => s.id === id)
    if (section && !ordered.includes(section)) ordered.push(section)
  }
  for (const section of listSections) if (!ordered.includes(section)) ordered.push(section)

  // Every operator placement is claimed before any default is filled in, so an
  // earlier section's defaults cannot take back an entry a later section placed.
  const claimed = new Map<NavSectionId, RailItemRef[]>()
  for (const section of ordered) {
    if (!section.direct) claimed.set(section.id, claim(layout?.sections[section.id]))
  }

  const resolveSection = (section: NavSection): RailSectionEntry => {
    const isFixed = fixed.has(section.id)
    const refs = [...(claimed.get(section.id) ?? [])]
    for (const ref of defaults.get(section.id) ?? []) {
      if (placed.has(ref)) continue
      placed.add(ref)
      refs.push(ref)
    }
    return { section, entries: refs.map(entry), fixed: isFixed, hidden: !isFixed && hidden.has(sectionRef(section.id)) }
  }

  return {
    pinned,
    sections: ordered.map(resolveSection),
    footer: navSections.filter((s) => s.footer).map(resolveSection),
  }
}

/**
 * The resolved rail written out as a complete layout — what every edit starts from.
 *
 * `previous` supplies hidden references to things that are not in the rail at
 * all (an uninstalled page the operator hid but never moved), which the rail
 * itself cannot carry.
 */
export function materializeLayout(rail: ResolvedRail, previous: RailLayout | null | undefined): RailLayout {
  const sections: Record<string, RailItemRef[]> = {}
  for (const s of rail.sections) {
    if (!s.section.direct) sections[s.section.id] = s.entries.map((e) => e.ref)
  }
  const listed = [...rail.pinned, ...rail.sections.flatMap((s) => s.entries)]
  const present = new Set<string>([...listed, ...rail.footer.flatMap((s) => s.entries)].map((e) => e.ref))
  const hidden: RailHiddenRef[] = [
    ...rail.sections.filter((s) => s.hidden).map((s) => sectionRef(s.section.id)),
    ...listed.filter((e) => e.hidden).map((e) => e.ref),
    ...(previous?.hidden ?? []).filter((ref) => !ref.startsWith(SECTION_REF_PREFIX) && !present.has(ref)),
  ]
  return {
    version: 1,
    pinned: rail.pinned.map((e) => e.ref),
    sectionOrder: rail.sections.map((s) => s.section.id),
    sections,
    hidden,
  }
}

export interface RailRouteMatch {
  /** The section holding the entry for this route; null when a pinned entry holds it. */
  section: NavSectionId | null
  pinnedRef: RailItemRef | null
}

function entryMatches(entry: RailEntry, pathname: string, view: AppView | null): boolean {
  const target = entry.target
  if (!target) return false
  if (target.kind === 'view') return view === target.view
  return pathname === target.page.path || pathname.startsWith(`${target.page.path}/`)
}

/** Where the rail holds the entry for a route, after the operator's moves; null when no entry does. */
export function routeSectionInRail(rail: ResolvedRail, pathname: string, view: AppView | null): RailRouteMatch | null {
  const pin = rail.pinned.find((e) => entryMatches(e, pathname, view))
  if (pin) return { section: null, pinnedRef: pin.ref }
  for (const s of [...rail.sections, ...rail.footer]) {
    if (s.entries.some((e) => entryMatches(e, pathname, view))) return { section: s.section.id, pinnedRef: null }
  }
  return null
}
```

- [ ] **Step 4: Register the test file**

In `package.json`, in the `test:runtime` script, replace `src/lib/app/panel-intent.test.ts ` with `src/lib/app/panel-intent.test.ts src/lib/app/rail-layout.test.ts ` (keep the trailing space and the rest of the line).

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx tsx --test src/lib/app/rail-layout.test.ts src/lib/app/nav-sections.test.ts`
Expected: PASS, 0 failures.
Run: `npx tsc --noEmit -p .` and `npx eslint src/lib/app/rail-layout.ts src/lib/app/rail-layout.test.ts src/lib/app/nav-sections.test.ts`
Expected: no errors.

- [ ] **Step 6: Mutation check**

Temporarily change the claim loop so defaults are filled per section before later sections claim (e.g. inline `claim(layout?.sections[section.id])` inside `resolveSection` and delete the `claimed` pre-pass). Run the rail-layout tests: "an earlier section cannot take back an entry a later section placed" must fail. Restore the file (`git diff` on it must be empty against your implementation) and record the result in your report.

- [ ] **Step 7: Commit**

```bash
git add src/lib/app/rail-layout.ts src/lib/app/rail-layout.test.ts src/lib/app/nav-sections.test.ts package.json
git commit -m "Resolve a stored rail layout against the section table

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_013wE44gRcx8yMbNmXZyGJZL"
```

---

### Task 2: Edit operations

**Files:**
- Create: `src/lib/app/rail-layout-edit.ts`
- Create: `src/lib/app/rail-layout-edit.test.ts`
- Modify: `package.json` (`test:runtime`)

**Interfaces:**
- Consumes (Task 1): `materializeLayout`, `sectionRef`, `isRailItemRef`, `RailEntry`, `RailHiddenRef`, `RailItemRef`, `RailLayout`, `ResolvedRail`; `NavSectionId`.
- Produces (Task 6 calls these; every one returns the next layout, or `null` when the edit is not allowed or changes nothing — the caller then saves nothing):
  - `type RailContainer = NavSectionId | 'pinned'`
  - `moveRailItemTo(rail: ResolvedRail, previous: RailLayout | null, ref: RailItemRef, to: RailContainer, before: RailItemRef | null): RailLayout | null`
  - `moveRailItemBy(rail: ResolvedRail, previous: RailLayout | null, ref: RailItemRef, delta: -1 | 1): RailLayout | null`
  - `setRailItemPinned(rail: ResolvedRail, previous: RailLayout | null, ref: RailItemRef, pinned: boolean): RailLayout | null`
  - `setRailHidden(rail: ResolvedRail, previous: RailLayout | null, ref: RailHiddenRef, hidden: boolean): RailLayout | null`
  - `moveRailSectionTo(rail: ResolvedRail, previous: RailLayout | null, id: NavSectionId, before: NavSectionId | null): RailLayout | null`
  - `moveRailSectionBy(rail: ResolvedRail, previous: RailLayout | null, id: NavSectionId, delta: -1 | 1): RailLayout | null`

- [ ] **Step 1: Write the failing tests**

Create `src/lib/app/rail-layout-edit.test.ts`:

```ts
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { NAV_SECTIONS } from './nav-sections'
import { resolveRailLayout, type RailLayout, type RailPage } from './rail-layout'
import {
  moveRailItemBy,
  moveRailItemTo,
  moveRailSectionBy,
  moveRailSectionTo,
  setRailHidden,
  setRailItemPinned,
} from './rail-layout-edit'

const PAGES: RailPage[] = [
  { extensionId: 'crm', id: 'crm', label: 'CRM', path: '/x/crm', section: 'work', order: 10 },
  { extensionId: 'docs', id: 'docs', label: 'Docs', path: '/x/docs', section: 'knowledge' },
]

function layout(patch: Partial<RailLayout>): RailLayout {
  return { version: 1, pinned: [], sectionOrder: [], sections: {}, hidden: [], ...patch }
}

const fresh = () => resolveRailLayout(NAV_SECTIONS, PAGES, undefined)
const last = (list: readonly string[] | undefined) => (list ?? []).slice(-1)[0]

describe('moveRailItemTo', () => {
  it('moves an entry before another entry of a different section', () => {
    const next = moveRailItemTo(fresh(), null, 'page:docs/docs', 'operations', 'view:usage')
    assert.ok(next)
    assert.deepEqual(next.sections.operations, ['view:stream', 'page:docs/docs', 'view:usage', 'view:quality', 'view:autonomy'])
    assert.deepEqual(next.sections.knowledge, ['view:memory', 'view:knowledge', 'view:skills'])
  })

  it('appends when there is nothing to insert before', () => {
    const next = moveRailItemTo(fresh(), null, 'view:tasks', 'knowledge', null)
    assert.equal(last(next?.sections.knowledge), 'view:tasks')
  })

  it('pins by moving into the pinned list', () => {
    assert.deepEqual(moveRailItemTo(fresh(), null, 'view:tasks', 'pinned', null)?.pinned, ['view:tasks'])
  })

  it('refuses a direct section, the fixed footer, and a footer entry', () => {
    assert.equal(moveRailItemTo(fresh(), null, 'view:tasks', 'home', null), null)
    assert.equal(moveRailItemTo(fresh(), null, 'view:tasks', 'settings', null), null)
    assert.equal(moveRailItemTo(fresh(), null, 'view:vault', 'work', null), null)
  })

  it('returns null for a move that changes nothing', () => {
    assert.equal(moveRailItemTo(fresh(), null, 'view:tasks', 'work', 'view:missions'), null)
  })
})

describe('moveRailItemBy', () => {
  it('steps over an entry that no longer exists, and stops at the edge', () => {
    const stored = layout({ sections: { work: ['view:tasks', 'page:gone/page', 'view:missions'] } })
    const rail = resolveRailLayout(NAV_SECTIONS, PAGES, stored)
    const down = moveRailItemBy(rail, stored, 'view:tasks', 1)
    assert.ok(down)
    assert.deepEqual((down.sections.work ?? []).filter((r) => r !== 'page:gone/page').slice(0, 2), ['view:missions', 'view:tasks'])
    assert.ok((down.sections.work ?? []).includes('page:gone/page'))
    assert.equal(moveRailItemBy(rail, stored, 'view:tasks', -1), null)
  })

  it('moves up within the pinned list', () => {
    const stored = layout({ pinned: ['view:tasks', 'view:agents'] })
    const rail = resolveRailLayout(NAV_SECTIONS, PAGES, stored)
    assert.deepEqual(moveRailItemBy(rail, stored, 'view:agents', -1)?.pinned, ['view:agents', 'view:tasks'])
  })
})

describe('setRailItemPinned', () => {
  it('pins to the end of the pinned list and unpins back to the end of the default section', () => {
    const pinned = setRailItemPinned(fresh(), null, 'view:tasks', true)
    assert.ok(pinned)
    assert.deepEqual(pinned.pinned, ['view:tasks'])
    assert.equal((pinned.sections.work ?? []).includes('view:tasks'), false)
    const rail = resolveRailLayout(NAV_SECTIONS, PAGES, pinned)
    const unpinned = setRailItemPinned(rail, pinned, 'view:tasks', false)
    assert.ok(unpinned)
    assert.deepEqual(unpinned.pinned, [])
    assert.equal(last(unpinned.sections.work), 'view:tasks')
    assert.equal(setRailItemPinned(rail, pinned, 'view:tasks', true), null)
    assert.equal(setRailItemPinned(fresh(), null, 'view:settings', true), null)
  })
})

describe('setRailHidden', () => {
  it('hides and shows entries and sections, but not Settings', () => {
    const hidden = setRailHidden(fresh(), null, 'section:connect', true)
    assert.ok(hidden)
    assert.deepEqual(hidden.hidden, ['section:connect'])
    const rail = resolveRailLayout(NAV_SECTIONS, PAGES, hidden)
    assert.equal(setRailHidden(rail, hidden, 'section:connect', true), null)
    assert.deepEqual(setRailHidden(rail, hidden, 'section:connect', false)?.hidden, [])
    assert.deepEqual(setRailHidden(fresh(), null, 'view:protocols', true)?.hidden, ['view:protocols'])
    assert.equal(setRailHidden(fresh(), null, 'section:settings', true), null)
    assert.equal(setRailHidden(fresh(), null, 'view:vault', true), null)
  })
})

describe('moving sections', () => {
  it('moves a section before another, to the end, and by one step', () => {
    assert.deepEqual(moveRailSectionTo(fresh(), null, 'operations', 'chat')?.sectionOrder, ['home', 'conversations', 'operations', 'chat', 'work', 'knowledge', 'connect'])
    assert.deepEqual(moveRailSectionTo(fresh(), null, 'home', null)?.sectionOrder.slice(-1), ['home'])
    assert.deepEqual(moveRailSectionBy(fresh(), null, 'work', -1)?.sectionOrder.slice(2, 4), ['work', 'chat'])
    assert.equal(moveRailSectionBy(fresh(), null, 'home', -1), null)
    assert.equal(moveRailSectionTo(fresh(), null, 'settings', null), null)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx tsx --test src/lib/app/rail-layout-edit.test.ts`
Expected: FAIL — `Cannot find module './rail-layout-edit'`.

- [ ] **Step 3: Implement `src/lib/app/rail-layout-edit.ts`**

```ts
import type { NavSectionId } from '@/lib/app/nav-sections'
import {
  isRailItemRef,
  materializeLayout,
  sectionRef,
  type RailEntry,
  type RailHiddenRef,
  type RailItemRef,
  type RailLayout,
  type ResolvedRail,
} from '@/lib/app/rail-layout'

/**
 * What each rail edit does to the stored layout.
 *
 * Every operation starts from the resolved rail written out in full
 * (`materializeLayout`), so the first edit also records the order the operator
 * was looking at. Each returns null when the edit is not allowed (the fixed
 * Settings section, a direct section) or would change nothing: the editor then
 * saves nothing.
 */

export type RailContainer = NavSectionId | 'pinned'

function findEntry(rail: ResolvedRail, ref: RailItemRef): { entry: RailEntry; container: RailContainer } | null {
  const pin = rail.pinned.find((e) => e.ref === ref)
  if (pin) return { entry: pin, container: 'pinned' }
  for (const s of rail.sections) {
    const entry = s.entries.find((e) => e.ref === ref)
    if (entry) return { entry, container: s.section.id }
  }
  return null
}

function listOf(layout: RailLayout, container: RailContainer): RailItemRef[] {
  if (container === 'pinned') return layout.pinned
  const list = layout.sections[container] ?? []
  layout.sections[container] = list
  return list
}

function acceptsEntries(rail: ResolvedRail, container: RailContainer): boolean {
  return container === 'pinned' || rail.sections.some((s) => s.section.id === container && !s.section.direct)
}

export function moveRailItemTo(
  rail: ResolvedRail,
  previous: RailLayout | null,
  ref: RailItemRef,
  to: RailContainer,
  before: RailItemRef | null,
): RailLayout | null {
  const found = findEntry(rail, ref)
  if (!found || before === ref || !acceptsEntries(rail, to)) return null
  const layout = materializeLayout(rail, previous)
  const unchanged = JSON.stringify(layout)
  const source = listOf(layout, found.container)
  source.splice(source.indexOf(ref), 1)
  const target = listOf(layout, to)
  const at = before === null ? -1 : target.indexOf(before)
  if (at === -1) target.push(ref)
  else target.splice(at, 0, ref)
  return JSON.stringify(layout) === unchanged ? null : layout
}

export function moveRailItemBy(rail: ResolvedRail, previous: RailLayout | null, ref: RailItemRef, delta: -1 | 1): RailLayout | null {
  const found = findEntry(rail, ref)
  if (!found) return null
  const list = found.container === 'pinned'
    ? rail.pinned
    : rail.sections.find((s) => s.section.id === found.container)?.entries ?? []
  // Only entries the editor shows count as neighbours; an uninstalled page is skipped over.
  const siblings = list.filter((e) => e.target !== null)
  const index = siblings.findIndex((e) => e.ref === ref)
  const neighbour = siblings[index + delta]
  if (index === -1 || !neighbour) return null
  if (delta < 0) return moveRailItemTo(rail, previous, ref, found.container, neighbour.ref)
  const after = siblings[index + 2]
  return moveRailItemTo(rail, previous, ref, found.container, after ? after.ref : null)
}

export function setRailItemPinned(rail: ResolvedRail, previous: RailLayout | null, ref: RailItemRef, pinned: boolean): RailLayout | null {
  const found = findEntry(rail, ref)
  if (!found) return null
  if (pinned) return found.container === 'pinned' ? null : moveRailItemTo(rail, previous, ref, 'pinned', null)
  if (found.container !== 'pinned' || !found.entry.home) return null
  return moveRailItemTo(rail, previous, ref, found.entry.home, null)
}

export function setRailHidden(rail: ResolvedRail, previous: RailLayout | null, ref: RailHiddenRef, hidden: boolean): RailLayout | null {
  if (isRailItemRef(ref)) {
    if (!findEntry(rail, ref)) return null
  } else if (!rail.sections.some((s) => sectionRef(s.section.id) === ref)) {
    return null
  }
  const layout = materializeLayout(rail, previous)
  if (layout.hidden.includes(ref) === hidden) return null
  layout.hidden = hidden ? [...layout.hidden, ref] : layout.hidden.filter((r) => r !== ref)
  return layout
}

export function moveRailSectionTo(rail: ResolvedRail, previous: RailLayout | null, id: NavSectionId, before: NavSectionId | null): RailLayout | null {
  if (before === id || !rail.sections.some((s) => s.section.id === id)) return null
  const layout = materializeLayout(rail, previous)
  const unchanged = JSON.stringify(layout.sectionOrder)
  const order = layout.sectionOrder.filter((s) => s !== id)
  const at = before === null ? -1 : order.indexOf(before)
  if (at === -1) order.push(id)
  else order.splice(at, 0, id)
  layout.sectionOrder = order
  return JSON.stringify(order) === unchanged ? null : layout
}

export function moveRailSectionBy(rail: ResolvedRail, previous: RailLayout | null, id: NavSectionId, delta: -1 | 1): RailLayout | null {
  const ids = rail.sections.map((s) => s.section.id)
  const index = ids.indexOf(id)
  if (index === -1 || !ids[index + delta]) return null
  return moveRailSectionTo(rail, previous, id, delta < 0 ? ids[index - 1] : ids[index + 2] ?? null)
}
```

- [ ] **Step 4: Register the test file**

In `package.json` `test:runtime`, replace `src/lib/app/rail-layout.test.ts ` with `src/lib/app/rail-layout.test.ts src/lib/app/rail-layout-edit.test.ts `.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx tsx --test src/lib/app/rail-layout-edit.test.ts src/lib/app/rail-layout.test.ts`
Expected: PASS.
Run: `npx tsc --noEmit -p .` and `npx eslint src/lib/app/rail-layout-edit.ts src/lib/app/rail-layout-edit.test.ts`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/lib/app/rail-layout-edit.ts src/lib/app/rail-layout-edit.test.ts package.json
git commit -m "Turn each rail edit into the next stored layout

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_013wE44gRcx8yMbNmXZyGJZL"
```

---

### Task 3: Store the layout on the server, validated, and save it optimistically

**Files:**
- Modify: `src/types/app-settings.ts` (after the `tabsEnabled?: boolean` field)
- Modify: `src/app/api/settings/route.ts` (`PUT`)
- Modify: `src/app/api/settings/settings-route.test.ts`
- Modify: `src/stores/slices/data-slice.ts`

**Interfaces:**
- Consumes (Task 1): `RailLayoutSchema`, `type RailLayout`.
- Produces: `AppSettings.railLayout?: RailLayout | null`; store action `updateRailLayout: (layout: RailLayout | null) => Promise<boolean>` (true when the server stored it). `PUT /api/settings` with `{ railLayout: <layout> }` stores it; `{ railLayout: null }` removes the field; an invalid shape answers `400 { error: 'Validation failed', issues: [...], field: 'railLayout' }` and writes nothing.

- [ ] **Step 1: Write the failing route test**

Append to `src/app/api/settings/settings-route.test.ts`:

```ts
test('settings route stores a valid railLayout, refuses an invalid one with 400, and clears it on null', () => {
  const output = runWithTempDataDir<{
    savedPinned: string[] | null
    invalidStatus: number
    invalidField: string | null
    afterInvalidPinned: string[] | null
    afterInvalidTheme: string | null
    afterResetHasLayout: boolean
  }>(`
    const routeMod = await import('./src/app/api/settings/route')
    const route = routeMod.default || routeMod
    const put = (body) => route.PUT(new Request('http://local/api/settings', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }))

    await put({ railLayout: { version: 1, pinned: ['view:tasks'], sectionOrder: ['work', 'home'], sections: { work: ['view:projects'] }, hidden: ['section:connect'] } })
    const saved = await (await route.GET()).json()

    const invalid = await put({ themeMode: 'light', railLayout: { version: 2, pinned: 'nope' } })
    const invalidBody = await invalid.json()
    const afterInvalid = await (await route.GET()).json()

    await put({ railLayout: null })
    const afterReset = await (await route.GET()).json()

    console.log(JSON.stringify({
      savedPinned: saved.railLayout ? saved.railLayout.pinned : null,
      invalidStatus: invalid.status,
      invalidField: invalidBody.field || null,
      afterInvalidPinned: afterInvalid.railLayout ? afterInvalid.railLayout.pinned : null,
      afterInvalidTheme: afterInvalid.themeMode || null,
      afterResetHasLayout: 'railLayout' in afterReset,
    }))
  `, { prefix: 'swarmclaw-settings-rail-layout-' })

  assert.deepEqual(output.savedPinned, ['view:tasks'])
  assert.equal(output.invalidStatus, 400)
  assert.equal(output.invalidField, 'railLayout')
  // Nothing from the refused request is written, the other key included.
  assert.deepEqual(output.afterInvalidPinned, ['view:tasks'])
  assert.notEqual(output.afterInvalidTheme, 'light')
  assert.equal(output.afterResetHasLayout, false)
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx tsx --test src/app/api/settings/settings-route.test.ts`
Expected: FAIL — `invalidStatus` is 200 (the route stores anything today).

- [ ] **Step 3: Add the settings field**

In `src/types/app-settings.ts`, add `import type { RailLayout } from '@/lib/app/rail-layout'` to the imports, and after `tabsEnabled?: boolean`:

```ts
  /**
   * The operator's own rail arrangement: pinned entries, section order, where
   * each entry sits, what is hidden. Undefined means the default rail. Written
   * only through `PUT /settings`, which validates it with `RailLayoutSchema`;
   * read with `readRailLayout`. Null in a request clears it.
   */
  railLayout?: RailLayout | null
```

- [ ] **Step 4: Validate in the route**

In `src/app/api/settings/route.ts`, add imports:

```ts
import { RailLayoutSchema } from '@/lib/app/rail-layout'
import { formatZodError } from '@/lib/validation/schemas'
```

In `PUT`, directly after the `for (const key of SECRET_SETTING_KEYS) { ... }` loop and before `const settings = loadSettings()`:

```ts
  // The rail layout is the one settings key the client builds structurally, so
  // it is the one the route checks structurally: a bad shape is refused whole,
  // naming the field, and nothing from the request is written.
  let clearRailLayout = false
  if ('railLayout' in sanitizedBody) {
    if (sanitizedBody.railLayout === null) {
      delete sanitizedBody.railLayout
      clearRailLayout = true
    } else {
      const parsed = RailLayoutSchema.safeParse(sanitizedBody.railLayout)
      if (!parsed.success) {
        return NextResponse.json({ ...formatZodError(parsed.error), field: 'railLayout' }, { status: 400 })
      }
      sanitizedBody.railLayout = parsed.data
    }
  }
```

and directly after `Object.assign(settings, sanitizedBody)`:

```ts
  if (clearRailLayout) delete settings.railLayout
```

Note: `changedKeys` below is computed from `sanitizedBody`; after a reset `railLayout` is no longer in it. Add it back for the activity log by changing the line to:

```ts
  const changedKeys = [...Object.keys(sanitizedBody), ...(clearRailLayout ? ['railLayout'] : [])].filter((k) => !SECRET_SETTING_KEYS.includes(k as typeof SECRET_SETTING_KEYS[number]))
```

- [ ] **Step 5: Run the route test to verify it passes**

Run: `npx tsx --test src/app/api/settings/settings-route.test.ts`
Expected: PASS (both tests).

- [ ] **Step 6: Add the optimistic store action**

In `src/stores/slices/data-slice.ts`:

Add to the imports:

```ts
import { hmrSingleton } from '@/lib/shared-utils'
import type { RailLayout } from '@/lib/app/rail-layout'
```

Below the imports, before `export interface DataSlice`:

```ts
/**
 * Which rail layout write is the newest. Edits are saved one request each and
 * can overlap; only the newest request's answer (or failure) may touch the
 * store, or an older answer would put back a layout the operator has already
 * moved past.
 */
const railLayoutWrites = hmrSingleton('dataSlice_railLayoutWrites', () => ({ latest: 0 }))
```

In `interface DataSlice`, after `updateSettings`:

```ts
  /** Saves the rail layout optimistically; resolves false when the server did not store it (the store is then put back). */
  updateRailLayout: (layout: RailLayout | null) => Promise<boolean>
```

In the slice object, after `updateSettings: async (patch) => { ... },`:

```ts
  updateRailLayout: async (layout) => {
    const write = ++railLayoutWrites.latest
    const before = get().appSettings.railLayout ?? null
    invalidateFingerprint('appSettings')
    set((s) => ({ appSettings: { ...s.appSettings, railLayout: layout } }))
    try {
      const settings = await api<AppSettings>('PUT', '/settings', { railLayout: layout })
      if (write === railLayoutWrites.latest) {
        invalidateFingerprint('appSettings')
        setIfChanged<AppState>(set, 'appSettings', settings)
      }
      return true
    } catch (err: unknown) {
      console.warn('Store error:', err)
      if (write === railLayoutWrites.latest) {
        invalidateFingerprint('appSettings')
        set((s) => ({ appSettings: { ...s.appSettings, railLayout: before } }))
      }
      return false
    }
  },
```

Check `src/lib/app/api-client.ts`: `api()` throws on a non-2xx answer (it does — `throw new Error(msg)`), which is what makes a 400 reach the `catch`.

- [ ] **Step 7: Verify**

Run: `npx tsx --test src/app/api/settings/settings-route.test.ts src/lib/app/rail-layout.test.ts`
Expected: PASS.
Run: `npx tsc --noEmit -p .` and `npx eslint src/types/app-settings.ts src/app/api/settings/route.ts src/app/api/settings/settings-route.test.ts src/stores/slices/data-slice.ts`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add src/types/app-settings.ts src/app/api/settings/route.ts src/app/api/settings/settings-route.test.ts src/stores/slices/data-slice.ts
git commit -m "Store the rail layout in settings, validated, saved optimistically

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_013wE44gRcx8yMbNmXZyGJZL"
```

---

### Task 4: View icons, and every rail view in the palette

**Files:**
- Create: `src/lib/app/view-icons.ts`, `src/lib/app/view-icons.test.ts`
- Create: `src/components/layout/view-icon.tsx`
- Create: `src/components/layout/section-icons.tsx`
- Create: `src/lib/app/palette-views.ts`, `src/lib/app/palette-views.test.ts`
- Modify: `src/components/layout/sidebar-rail.tsx` (import `SECTION_ICONS` from the new file instead of defining it)
- Modify: `src/components/layout/tab-strip.tsx` (import path; view icon)
- Modify: `src/lib/app/tab-label.ts`, `src/lib/app/tab-label.test.ts` (`view` on `TabLabel`)
- Modify: `src/components/shared/command-palette.tsx`
- Modify: `package.json` (`test:runtime`)

**Interfaces:**
- Consumes: `AppView`, `VIEW_LABELS`, `VIEW_DESCRIPTIONS`, `NAV_SECTIONS`, `NavSectionIconName`.
- Produces:
  - `type ViewIconName`, `const VIEW_ICONS: Record<AppView, ViewIconName>` (`src/lib/app/view-icons.ts`)
  - `function ViewIcon({ view, size }: { view: AppView; size?: number }): JSX.Element` (`src/components/layout/view-icon.tsx`)
  - `const SECTION_ICONS: Record<NavSectionIconName, React.ComponentType<{ size?: number }>>` (`src/components/layout/section-icons.tsx`)
  - `interface TabLabel { title: string; sectionId: NavSectionId | null; view: AppView | null; extensionIcon: string | null }`
  - `interface PaletteViewTarget { view: AppView; label: string; description: string; keywords: string[] }`, `function paletteViewTargets(): PaletteViewTarget[]`

- [ ] **Step 1: Write the failing tests**

Create `src/lib/app/view-icons.test.ts`:

```ts
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { VIEW_ICONS } from './view-icons'
import { VIEW_LABELS } from './view-constants'

describe('VIEW_ICONS', () => {
  it('names an icon for exactly the views that have a label', () => {
    assert.deepEqual(Object.keys(VIEW_ICONS).sort(), Object.keys(VIEW_LABELS).sort())
  })
})
```

Create `src/lib/app/palette-views.test.ts`:

```ts
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { NAV_SECTIONS } from './nav-sections'
import { paletteViewTargets } from './palette-views'

describe('paletteViewTargets', () => {
  // A hidden rail entry must stay reachable with Cmd+K: every view the rail can list is a palette destination.
  it('lists every view a rail section claims, once', () => {
    const claimed = NAV_SECTIONS.flatMap((s) => [...(s.direct ? [s.direct] : []), ...s.views]).sort()
    const listed = paletteViewTargets().map((t) => t.view)
    assert.deepEqual([...listed].sort(), claimed)
    assert.equal(new Set(listed).size, listed.length)
  })

  it('keeps the curated entries first, with their wording', () => {
    const targets = paletteViewTargets()
    assert.equal(targets[0].view, 'home')
    const agents = targets.find((t) => t.view === 'agents')
    assert.equal(agents?.label, 'Agents')
    assert.deepEqual(agents?.keywords, ['chat', 'assistant', 'default'])
    assert.equal(targets.find((t) => t.view === 'protocols')?.label, 'Sessions')
  })
})
```

In `src/lib/app/tab-label.test.ts`, change the three `deepEqual` expectations to carry `view`:

```ts
    assert.deepEqual(tabLabel('/tasks', null, lookups), { title: 'Tasks', sectionId: 'work', view: 'tasks', extensionIcon: null })
```
```ts
    assert.deepEqual(tabLabel('/x/crm/ugyfelek/acc_1', null, lookups), { title: 'CRM', sectionId: 'work', view: null, extensionIcon: 'Users' })
```
```ts
    assert.deepEqual(tabLabel('/nowhere', null, lookups), { title: '/nowhere', sectionId: null, view: null, extensionIcon: null })
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx tsx --test src/lib/app/view-icons.test.ts src/lib/app/palette-views.test.ts src/lib/app/tab-label.test.ts`
Expected: FAIL — missing modules, and `tab-label` results without `view`.

- [ ] **Step 3: Create `src/lib/app/view-icons.ts`**

```ts
import type { AppView } from '@/types'

/**
 * The lucide icon names behind `VIEW_ICONS`. A string union, not a lucide
 * import, so this table stays importable by tests and server code; the client
 * map in `components/layout/view-icon.tsx` is typed by it, so a name missing
 * on either side is a compile error.
 */
export type ViewIconName =
  | 'Home' | 'MessageSquare' | 'Users' | 'Network' | 'Inbox' | 'MessagesSquare' | 'Workflow' | 'CalendarClock'
  | 'Brain' | 'ListTodo' | 'ShieldCheck' | 'KeyRound' | 'Cpu' | 'Sparkles' | 'Plug' | 'Webhook' | 'Server'
  | 'Library' | 'Puzzle' | 'BarChart3' | 'Activity' | 'Gauge' | 'Settings' | 'FolderKanban' | 'Rss' | 'Store' | 'Target'

/** Every view's own icon: pinned rail rows and tabs use it, where a section icon would say too little. */
export const VIEW_ICONS: Record<AppView, ViewIconName> = {
  home: 'Home',
  conversations: 'MessageSquare',
  agents: 'Users',
  org_chart: 'Network',
  inbox: 'Inbox',
  chatrooms: 'MessagesSquare',
  protocols: 'Workflow',
  schedules: 'CalendarClock',
  memory: 'Brain',
  tasks: 'ListTodo',
  quality: 'ShieldCheck',
  missions: 'Target',
  vault: 'KeyRound',
  providers: 'Cpu',
  skills: 'Sparkles',
  connectors: 'Plug',
  webhooks: 'Webhook',
  mcp_servers: 'Server',
  knowledge: 'Library',
  extensions: 'Puzzle',
  usage: 'BarChart3',
  stream: 'Activity',
  autonomy: 'Gauge',
  settings: 'Settings',
  projects: 'FolderKanban',
  swarmfeed: 'Rss',
  marketplace: 'Store',
}
```

- [ ] **Step 4: Create `src/components/layout/view-icon.tsx`**

```tsx
'use client'

import {
  Activity, BarChart3, Brain, CalendarClock, Cpu, FolderKanban, Gauge, Home, Inbox, KeyRound, Library, ListTodo,
  MessageSquare, MessagesSquare, Network, Plug, Puzzle, Rss, Server, Settings, ShieldCheck, Sparkles, Store,
  Target, Users, Webhook, Workflow,
} from 'lucide-react'
import { VIEW_ICONS, type ViewIconName } from '@/lib/app/view-icons'
import type { AppView } from '@/types'

const ICONS: Record<ViewIconName, React.ComponentType<{ size?: number }>> = {
  Activity, BarChart3, Brain, CalendarClock, Cpu, FolderKanban, Gauge, Home, Inbox, KeyRound, Library, ListTodo,
  MessageSquare, MessagesSquare, Network, Plug, Puzzle, Rss, Server, Settings, ShieldCheck, Sparkles, Store,
  Target, Users, Webhook, Workflow,
}

export function ViewIcon({ view, size = 17 }: { view: AppView; size?: number }) {
  const Icon = ICONS[VIEW_ICONS[view]]
  return <Icon size={size} />
}
```

- [ ] **Step 5: Move `SECTION_ICONS` into `src/components/layout/section-icons.tsx`**

```tsx
'use client'

import { Activity, BookOpen, Briefcase, Home, Link2, MessageSquare, Settings, Users } from 'lucide-react'
import type { NavSectionIconName } from '@/lib/app/nav-sections'

/**
 * The components behind the icon names in `NAV_SECTIONS`.
 *
 * Kept out of the table so the table stays importable by server code and tests
 * without pulling a client-only icon library in behind it, and out of the rail
 * so the rail editor and the tab strip can use it without importing the rail.
 * Typed by `NavSectionIconName`, so a missing name on either side is a compile
 * error, not a section that silently renders the Home icon.
 */
export const SECTION_ICONS: Record<NavSectionIconName, React.ComponentType<{ size?: number }>> = {
  Home, MessageSquare, Users, Briefcase, BookOpen, Link2, Activity, Settings,
}
```

In `src/components/layout/sidebar-rail.tsx`: delete the `SECTION_ICONS` doc comment and constant (lines "The components behind the icon names in `NAV_SECTIONS`" through the closing `}`), change the lucide import to `import { Home } from 'lucide-react'` (Home is still the fallback in `renderSection`), and add `import { SECTION_ICONS } from '@/components/layout/section-icons'`. Remove `type NavSectionIconName` from the nav-sections import if nothing else uses it.

- [ ] **Step 6: Tabs carry the view and show its icon**

In `src/lib/app/tab-label.ts`, add `view: AppView | null` to `TabLabel`:

```ts
export interface TabLabel {
  title: string
  sectionId: NavSectionId | null
  /** The built-in view the tab shows; null on an extension page or an unknown route. */
  view: AppView | null
  extensionIcon: string | null
}
```

and return it from `tabLabel`:

```ts
  if (page) return { title: raw ?? page.label, sectionId: resolvePageSection(page), view: null, extensionIcon: page.icon ?? null }
  const parsed = parseViewPath(pathname)
  if (!parsed) return { title: raw ?? pathname, sectionId: null, view: null, extensionIcon: null }
  const entity = parsed.id ? entityName(parsed.view, parsed.id, lookups) : null
  return { title: entity ?? VIEW_LABELS[parsed.view], sectionId: sectionForView(parsed.view), view: parsed.view, extensionIcon: null }
```

In `src/components/layout/tab-strip.tsx`, change `import { SECTION_ICONS } from '@/components/layout/sidebar-rail'` to `import { SECTION_ICONS } from '@/components/layout/section-icons'`, add `import { ViewIcon } from '@/components/layout/view-icon'`, and replace `TabIcon`:

```tsx
function TabIcon({ label }: { label: TabLabel | undefined }) {
  if (label?.extensionIcon) return <PageIcon name={label.extensionIcon} size={13} />
  if (label?.view) return <ViewIcon view={label.view} size={13} />
  const section = NAV_SECTIONS.find((s) => s.id === label?.sectionId)
  const Icon = section ? SECTION_ICONS[section.icon] : Home
  return <Icon size={13} />
}
```

- [ ] **Step 7: Create `src/lib/app/palette-views.ts`**

```ts
import { NAV_SECTIONS } from '@/lib/app/nav-sections'
import { VIEW_DESCRIPTIONS, VIEW_LABELS } from '@/lib/app/view-constants'
import type { AppView } from '@/types'

export interface PaletteViewTarget {
  view: AppView
  label: string
  description: string
  keywords: string[]
}

/**
 * The palette's hand-written view entries, unchanged, in their order. They
 * carry search keywords and a palette-specific wording the view tables do not.
 */
const CURATED: readonly PaletteViewTarget[] = [
  { view: 'home', label: 'Home', description: 'Overview and triage', keywords: ['dashboard', 'overview', 'activity'] },
  { view: 'agents', label: 'Agents', description: 'Agent chats and configuration', keywords: ['chat', 'assistant', 'default'] },
  { view: 'tasks', label: 'Tasks', description: 'Task board and execution queues', keywords: ['board', 'queue', 'backlog', 'execution'] },
  { view: 'projects', label: 'Projects', description: 'Scoped workspaces for agents and tasks', keywords: ['workspace', 'scope'] },
  { view: 'chatrooms', label: 'Chatrooms', description: 'Shared multi-agent conversations', keywords: ['group', 'room', 'mentions'] },
  { view: 'schedules', label: 'Schedules', description: 'Recurring and timed automations', keywords: ['cron', 'automation', 'interval'] },
  { view: 'connectors', label: 'Connectors', description: 'Bridges to Slack, Discord, Telegram, file queues, and more', keywords: ['discord', 'slack', 'telegram', 'whatsapp', 'file queue'] },
  { view: 'memory', label: 'Memory', description: 'Stored agent memory and retrieval', keywords: ['knowledge', 'vector', 'retrieval'] },
  { view: 'knowledge', label: 'Knowledge', description: 'Shared knowledge base', keywords: ['docs', 'entries', 'facts'] },
  { view: 'providers', label: 'Providers', description: 'Model providers and endpoints', keywords: ['openai', 'anthropic', 'ollama', 'endpoint'] },
  { view: 'vault', label: 'Vault', description: 'API keys, encrypted secrets, and agent wallets', keywords: ['api key', 'token', 'credential', 'secret', 'wallet'] },
  { view: 'stream', label: 'Stream', description: 'Run history, entity audit trail, and application logs', keywords: ['runs', 'activity', 'logs', 'audit', 'history'] },
  { view: 'autonomy', label: 'Autonomy', description: 'Estops, incidents, and runtime controls', keywords: ['estop', 'incident', 'runtime', 'safety'] },
  { view: 'quality', label: 'Quality', description: 'Evals, approvals, run review, and release readiness', keywords: ['eval', 'approval', 'runs', 'release', 'qa'] },
  { view: 'settings', label: 'Settings', description: 'General app configuration', keywords: ['preferences', 'theme', 'heartbeat'] },
]

/**
 * Every view the rail can list, as a Cmd+K destination.
 *
 * The rail editor can hide any entry, so the palette is the way back to it:
 * the curated entries first, then every other view a rail section claims, in
 * rail order, named from the view tables.
 */
export function paletteViewTargets(): PaletteViewTarget[] {
  const targets = [...CURATED]
  const listed = new Set<AppView>(targets.map((t) => t.view))
  for (const section of NAV_SECTIONS) {
    for (const view of [...(section.direct ? [section.direct] : []), ...section.views]) {
      if (listed.has(view)) continue
      listed.add(view)
      targets.push({ view, label: VIEW_LABELS[view], description: VIEW_DESCRIPTIONS[view], keywords: [] })
    }
  }
  return targets
}
```

- [ ] **Step 8: Use it in the palette**

In `src/components/shared/command-palette.tsx`, add `import { paletteViewTargets } from '@/lib/app/palette-views'` and replace the whole `const views = [ ... ] as const` array plus its `for (const view of views) { ... }` loop with:

```tsx
    for (const target of paletteViewTargets()) {
      result.push({
        id: `nav:${target.view}`,
        label: `Go to ${target.label}`,
        description: target.description,
        keywords: target.keywords,
        category: 'nav',
        onSelect: () => { navigateTo(target.view); setOpen(false) },
      })
    }
```

- [ ] **Step 9: Register the tests, verify, commit**

In `package.json` `test:runtime`, replace `src/lib/app/rail-layout-edit.test.ts ` with `src/lib/app/rail-layout-edit.test.ts src/lib/app/view-icons.test.ts src/lib/app/palette-views.test.ts `.

Run: `npx tsx --test src/lib/app/view-icons.test.ts src/lib/app/palette-views.test.ts src/lib/app/tab-label.test.ts`
Expected: PASS.
Run: `npx tsc --noEmit -p .` and `npx eslint` on every file changed in this task.
Expected: no errors.

```bash
git add src/lib/app/view-icons.ts src/lib/app/view-icons.test.ts src/components/layout/view-icon.tsx src/components/layout/section-icons.tsx src/lib/app/palette-views.ts src/lib/app/palette-views.test.ts src/components/layout/sidebar-rail.tsx src/components/layout/tab-strip.tsx src/lib/app/tab-label.ts src/lib/app/tab-label.test.ts src/components/shared/command-palette.tsx package.json
git commit -m "Give every view an icon, and list every rail view in the palette

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_013wE44gRcx8yMbNmXZyGJZL"
```

---

### Task 5: The rail renders the resolved layout

**Files:**
- Modify: `src/components/layout/sidebar-rail.tsx`
- Modify: `src/components/layout/extension-nav-items.tsx` (remove `ExtensionPagesForSection` and `ExtensionPageLinks`; keep `PageIcon`)
- Modify: `src/components/layout/nav-item.tsx` (doc comment mentions `ExtensionPagesForSection`)

**Interfaces:**
- Consumes: Task 1 (`resolveRailLayout`, `readRailLayout`, `routeSectionInRail`, `RailEntry`, `RailSectionEntry`), Task 4 (`ViewIcon`, `SECTION_ICONS`), `PageIcon`, `ExtensionNavItem`, `RailTooltip`.
- Produces: the rail renders `rail.pinned`, then `rail.sections` (hidden ones skipped), then `rail.footer`. Task 6 adds edit mode on top of the `rail` value this task computes.

There is no component test harness in this repo; the logic lives in Tasks 1–2. This task is verified with `tsc`, `eslint`, the existing rail tests, and the live check in Task 7.

- [ ] **Step 1: Imports**

In `src/components/layout/sidebar-rail.tsx`:
- `import { Fragment, useEffect, useMemo, useState } from 'react'`
- remove `import { ExtensionPagesForSection } from '@/components/layout/extension-nav-items'`
- add:

```tsx
import { ExtensionNavItem } from '@/components/layout/nav-item'
import { PageIcon } from '@/components/layout/extension-nav-items'
import { ViewIcon } from '@/components/layout/view-icon'
import {
  readRailLayout,
  resolveRailLayout,
  routeSectionInRail,
  type RailEntry,
  type RailSectionEntry,
} from '@/lib/app/rail-layout'
```

- change `import { NAV_SECTIONS, type NavSection, type NavSectionId } from '@/lib/app/nav-sections'` (drop what becomes unused after this task; `tsc`/`eslint` will tell you).
- `RailTooltip` is already imported from `@/components/layout/nav-item`; merge the two imports from that module into one.

- [ ] **Step 2: A shared visibility rule and the new `SectionSubList`**

Replace the whole `SectionSubList` function (keep its long doc comment, but change "extension pages still come first, above a hairline" to "a section's leading extension pages sit above a hairline") with:

```tsx
/** Whether the rail shows an entry outside edit mode: it exists, is not hidden, and its view is switched on. */
function isShownEntry(entry: RailEntry, isViewEnabled: (view: AppView) => boolean): boolean {
  const target = entry.target
  if (!target || entry.hidden) return false
  return target.kind === 'page' || isViewEnabled(target.view)
}

function SectionSubList({ entries, isViewEnabled, badges, onSelectView, onExtensionNavigate }: {
  entries: readonly RailEntry[]
  isViewEnabled: (view: AppView) => boolean
  badges: Partial<Record<AppView, number>>
  onSelectView: (view: AppView) => void
  onExtensionNavigate: () => void
}) {
  const pathname = usePathname()
  const shown = entries.filter((e) => isShownEntry(e, isViewEnabled))
  // The hairline follows a leading run of extension pages, when something else comes after it.
  const firstNonPage = shown.findIndex((e) => e.target?.kind !== 'page')
  const ruleAfter = firstNonPage > 0 ? firstNonPage - 1 : -1
  return (
    <div className="ml-5 pl-2 mt-0.5 mb-1 flex flex-col gap-0.5 border-l border-line-subtle">
      {shown.map((entry, index) => {
        const target = entry.target
        if (!target) return null
        const rule = index === ruleAfter ? <div className="my-2 mx-2 h-px bg-line-subtle" /> : null
        if (target.kind === 'page') {
          const { page } = target
          return (
            <Fragment key={entry.ref}>
              <ExtensionNavItem
                href={page.path}
                label={page.label}
                isActive={pathname === page.path || pathname.startsWith(`${page.path}/`)}
                onClick={onExtensionNavigate}
                panel="close"
              >
                <PageIcon name={page.icon} />
              </ExtensionNavItem>
              {rule}
            </Fragment>
          )
        }
        const view = target.view
        const href = getViewPath(view)
        const on = pathname === href || pathname.startsWith(`${href}/`)
        const badge = badges[view]
        return (
          <Fragment key={entry.ref}>
            <Link
              href={href}
              onClick={(e) => {
                // A background tab leaves the active tab where it is, so the rail's own handling has nothing to follow.
                // In the tab host the panel lives in the tab, so the intent travels with the navigation.
                if (routeLinkClick(e, href, { panel: panelIntentForView(view) }) === 'background') return
                onSelectView(view)
              }}
              onAuxClick={(e) => { if (e.button === 1) routeLinkClick(e, href) }}
              aria-current={on ? 'page' : undefined}
              className={`flex items-center gap-2 px-2.5 py-1.5 rounded-full text-[12.5px] transition-colors no-underline ${
                on ? 'bg-accent-soft text-accent-bright font-600' : 'text-text-2 hover:bg-layer-2 hover:text-text'
              }`}
            >
              <span className="truncate">{VIEW_LABELS[view]}</span>
              {!!badge && (
                <span className="ml-auto shrink-0 min-w-[16px] h-[16px] rounded-full bg-amber-500 text-black text-[9px] font-700 flex items-center justify-center px-1">
                  {badge}
                </span>
              )}
            </Link>
            {rule}
          </Fragment>
        )
      })}
    </div>
  )
}
```

- [ ] **Step 3: A pinned row**

Add below `SectionSubList`:

```tsx
/**
 * An entry the operator pinned above the sections. Labelled on the wide rail,
 * an icon with a tooltip on the 52px one — the same two forms a section row has.
 */
function PinnedRow({ entry, expanded, onSelectView, onExtensionNavigate }: {
  entry: RailEntry
  expanded: boolean
  onSelectView: (view: AppView) => void
  onExtensionNavigate: () => void
}) {
  const pathname = usePathname()
  const target = entry.target
  if (!target) return null
  const href = target.kind === 'view' ? getViewPath(target.view) : target.page.path
  const label = target.kind === 'view' ? VIEW_LABELS[target.view] : target.page.label
  const on = target.kind === 'view'
    ? resolveSidebarActiveView(pathname) === target.view
    : pathname === href || pathname.startsWith(`${href}/`)
  const panel = target.kind === 'view' ? panelIntentForView(target.view) : 'close'
  const className = expanded
    ? `w-full flex items-center gap-2.5 px-3 py-2 rounded-full text-[13px] font-600 transition-all no-underline ${
      on ? 'bg-accent-soft text-accent-bright' : 'text-text-3 hover:text-text hover:bg-layer-2'}`
    : `rail-btn ${on ? 'active' : ''} relative no-underline`
  const link = (
    <Link
      href={href}
      onClick={(e) => {
        if (routeLinkClick(e, href, { panel }) === 'background') return
        if (target.kind === 'view') onSelectView(target.view)
        else onExtensionNavigate()
      }}
      onAuxClick={(e) => { if (e.button === 1) routeLinkClick(e, href) }}
      aria-current={on ? 'page' : undefined}
      className={className}
      style={{ fontFamily: 'inherit' }}
    >
      <span className="shrink-0 flex items-center">
        {target.kind === 'view' ? <ViewIcon view={target.view} size={17} /> : <PageIcon name={target.page.icon} size={17} />}
      </span>
      {expanded && <span className="truncate">{label}</span>}
    </Link>
  )
  if (expanded) return link
  return (
    <RailTooltip label={label} description={target.kind === 'view' ? VIEW_DESCRIPTIONS[target.view] : 'Extension page'}>
      {link}
    </RailTooltip>
  )
}
```

- [ ] **Step 4: Resolve the layout in `SidebarRail`**

In `SidebarRail`, replace:

```tsx
  const extensionPages = useExtensionPages()
  const routeSection = railSectionForPath(pathname, activeView, extensionPages)
```

with:

```tsx
  const extensionPages = useExtensionPages()
  const storedRailLayout = appSettings.railLayout
  // The static table, the installed pages and the operator's own arrangement,
  // resolved once per change. A stored value this version cannot read is the default rail.
  const rail = useMemo(
    () => resolveRailLayout(NAV_SECTIONS, extensionPages, readRailLayout(storedRailLayout)),
    [extensionPages, storedRailLayout],
  )
  // Where the rail holds this route after the operator's moves; a pinned entry lights its own row instead of a section.
  const inRail = routeSectionInRail(rail, pathname, activeView)
  const routeSection = inRail ? inRail.section : railSectionForPath(pathname, activeView, extensionPages)
```

Replace `sectionHint`:

```tsx
  const sectionHint = (entry: RailSectionEntry) => entry.section.direct
    ? VIEW_DESCRIPTIONS[entry.section.direct]
    : entry.entries
      .filter((e) => isShownEntry(e, isViewEnabled))
      .map((e) => (e.target?.kind === 'view' ? VIEW_LABELS[e.target.view] : e.target?.page.label ?? ''))
      .join(' · ')
```

Change `renderSection` to take a resolved section. Its first lines become:

```tsx
  const renderSection = (entry: RailSectionEntry) => {
    const section = entry.section
    const Icon = SECTION_ICONS[section.icon] ?? Home
    const highlighted = highlightedSection === section.id
    const expanded = railExpanded && openSection === section.id
    const count = entry.entries.reduce((n, e) => n + (e.target?.kind === 'view' ? badges[e.target.view] ?? 0 : 0), 0)
```

(keep the long comment above `highlighted`), pass `sectionHint(entry)` to the tooltip, and pass the entries to the list:

```tsx
        <SectionSubList
          entries={entry.entries}
          isViewEnabled={isViewEnabled}
          badges={badges}
          onSelectView={handleNavClick}
          onExtensionNavigate={handleExtensionNavClick}
        />
```

- [ ] **Step 5: Render pinned rows, visible sections and the footer from the resolved rail**

Replace:

```tsx
        <nav className={`flex flex-col gap-0.5 ${railExpanded ? 'px-3' : 'items-center'}`}>
          {NAV_SECTIONS.filter((s) => !s.footer).map(renderSection)}
        </nav>
```

with:

```tsx
        <nav className={`flex flex-col gap-0.5 ${railExpanded ? 'px-3' : 'items-center'}`}>
          {rail.pinned.some((e) => isShownEntry(e, isViewEnabled)) && (
            <>
              {rail.pinned.filter((e) => isShownEntry(e, isViewEnabled)).map((entry) => (
                <PinnedRow
                  key={entry.ref}
                  entry={entry}
                  expanded={railExpanded}
                  onSelectView={handleNavClick}
                  onExtensionNavigate={handleExtensionNavClick}
                />
              ))}
              <div className={railExpanded ? 'my-1.5 mx-3 h-px bg-line-subtle' : 'my-1.5 w-6 h-px bg-line-subtle'} />
            </>
          )}
          {rail.sections.filter((s) => !s.hidden).map(renderSection)}
        </nav>
```

and replace:

```tsx
            {NAV_SECTIONS.filter((s) => s.footer).map(renderSection)}
```

with:

```tsx
            {rail.footer.map(renderSection)}
```

- [ ] **Step 6: Remove the unused extension list components**

In `src/components/layout/extension-nav-items.tsx`, delete `ExtensionPageLinks` and `ExtensionPagesForSection` with their doc comments, and the imports only they used (`usePathname`, `ExtensionNavItem`, `pagesForSection`, `useExtensionPages`, `ExtensionPage`, `NavSectionId`, `PanelIntent`). Keep `PAGE_ICONS`, `ICON_BY_NAME` and `PageIcon`. Run `grep -rn "ExtensionPagesForSection" src` and fix any remaining mention (the doc comment in `nav-item.tsx`: say the row is mounted in a rail section's list by `SectionSubList` in `sidebar-rail.tsx`). Leave `pagesForSection` in `src/hooks/use-extension-pages.ts` (it has its own tests).

- [ ] **Step 7: Verify**

Run: `npx tsc --noEmit -p .`
Expected: no errors.
Run: `npx eslint src/components/layout/sidebar-rail.tsx src/components/layout/extension-nav-items.tsx src/components/layout/nav-item.tsx`
Expected: no issues.
Run: `npx tsx --test src/lib/app/rail-state.test.ts src/lib/app/nav-sections.test.ts src/lib/app/rail-layout.test.ts src/hooks/use-extension-pages.test.ts`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/components/layout/sidebar-rail.tsx src/components/layout/extension-nav-items.tsx src/components/layout/nav-item.tsx
git commit -m "Draw the rail from the resolved layout, with pinned entries on top

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_013wE44gRcx8yMbNmXZyGJZL"
```

---

### Task 6: Edit mode

**Files:**
- Create: `src/components/layout/rail-editor.tsx`
- Modify: `src/components/layout/sidebar-rail.tsx`

**Interfaces:**
- Consumes: Task 1 (`ResolvedRail`, `RailEntry`, `RailSectionEntry`, `RailItemRef`, `RailLayout`, `readRailLayout`, `isRailItemRef`, `sectionRef`), Task 2 (all edit operations, `RailContainer`), Task 3 (`updateRailLayout` in the store), Task 4 (`ViewIcon`, `SECTION_ICONS`), `PageIcon`, `ConfirmDialog`, `DropdownMenu*` from `@/components/ui/dropdown-menu`, `NAV_SECTION_IDS`.
- Produces: `export function RailEditor({ rail, isViewEnabled, onDone }: { rail: ResolvedRail; isViewEnabled: (view: AppView) => boolean; onDone: () => void })`.

Behaviour (from the spec): "Customize" at the bottom of the rail enters edit mode, "Done" leaves it. Every section opens; hidden entries and sections show faded in place. Each row: drag handle, eye (hide/show), pin (pin/unpin), and a ⋯ menu (Move up, Move down, Move to → section, Pin/Unpin, Hide/Show) as the keyboard alternative. Sections: drag handle, eye, ⋯ (Move up, Move down, Hide/Show). Settings is listed as fixed with no controls. Every change saves at once; "Reset" asks first, then writes `null`. Editing is desktop only.

- [ ] **Step 1: Create `src/components/layout/rail-editor.tsx`**

```tsx
'use client'

import { useState, type DragEvent, type ReactNode } from 'react'
import { Check, Eye, EyeOff, GripVertical, MoreHorizontal, Pin, PinOff, RotateCcw } from 'lucide-react'
import { toast } from 'sonner'
import { ConfirmDialog } from '@/components/shared/confirm-dialog'
import { PageIcon } from '@/components/layout/extension-nav-items'
import { SECTION_ICONS } from '@/components/layout/section-icons'
import { ViewIcon } from '@/components/layout/view-icon'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { NAV_SECTION_IDS, type NavSectionId } from '@/lib/app/nav-sections'
import {
  isRailItemRef,
  readRailLayout,
  sectionRef,
  type RailEntry,
  type RailItemRef,
  type RailLayout,
  type RailSectionEntry,
  type ResolvedRail,
} from '@/lib/app/rail-layout'
import {
  moveRailItemBy,
  moveRailItemTo,
  moveRailSectionBy,
  moveRailSectionTo,
  setRailHidden,
  setRailItemPinned,
  type RailContainer,
} from '@/lib/app/rail-layout-edit'
import { VIEW_LABELS } from '@/lib/app/view-constants'
import { useAppStore } from '@/stores/use-app-store'
import type { AppView } from '@/types'

/** A private drag type, so a file or a task card dragged over the rail is not taken for a rail entry. */
const DRAG_TYPE = 'application/x-sidekick-rail'

type DragPayload = { kind: 'item'; ref: RailItemRef } | { kind: 'section'; id: NavSectionId }

function readDrag(e: DragEvent): DragPayload | null {
  let raw: unknown
  try {
    raw = JSON.parse(e.dataTransfer.getData(DRAG_TYPE))
  } catch {
    return null
  }
  if (typeof raw !== 'object' || raw === null || !('kind' in raw)) return null
  if (raw.kind === 'item' && 'ref' in raw && isRailItemRef(raw.ref)) return { kind: 'item', ref: raw.ref }
  if (raw.kind === 'section' && 'id' in raw) {
    const id = NAV_SECTION_IDS.find((s) => s === raw.id)
    if (id) return { kind: 'section', id }
  }
  return null
}

const ICON_BUTTON = 'shrink-0 w-6 h-6 rounded-sm flex items-center justify-center border-none bg-transparent text-text-3 hover:text-text hover:bg-surface cursor-pointer'

function IconButton({ label, onClick, children }: { label: string; onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" aria-label={label} title={label} onClick={onClick} className={ICON_BUTTON}>
      {children}
    </button>
  )
}

/**
 * The rail in edit mode.
 *
 * Every control computes the next layout with a pure operation
 * (`rail-layout-edit.ts`) and saves it at once — there is no Cancel, as the
 * spec asks. An operation that is not allowed or changes nothing returns null,
 * and nothing is saved. Drag and drop is native HTML5; the ⋯ menu offers the
 * same moves from the keyboard.
 */
export function RailEditor({ rail, isViewEnabled, onDone }: {
  rail: ResolvedRail
  isViewEnabled: (view: AppView) => boolean
  onDone: () => void
}) {
  const stored = useAppStore((s) => s.appSettings.railLayout)
  const updateRailLayout = useAppStore((s) => s.updateRailLayout)
  const [confirmReset, setConfirmReset] = useState(false)
  const previous = readRailLayout(stored)

  const commit = (next: RailLayout | null) => {
    if (!next) return
    void updateRailLayout(next).then((ok) => {
      if (!ok) toast.error('Could not save the sidebar layout. The last change was undone.')
    })
  }

  const reset = () => {
    setConfirmReset(false)
    void updateRailLayout(null).then((ok) => {
      if (!ok) toast.error('Could not reset the sidebar layout.')
    })
  }

  const shown = (entry: RailEntry) => {
    const target = entry.target
    return !!target && (target.kind === 'page' || isViewEnabled(target.view))
  }
  const listSections = rail.sections.filter((s) => !s.section.direct)

  const startDrag = (e: DragEvent, payload: DragPayload) => {
    e.dataTransfer.setData(DRAG_TYPE, JSON.stringify(payload))
    e.dataTransfer.effectAllowed = 'move'
  }
  // The payload cannot be read during dragover, only its type.
  const allowDrop = (e: DragEvent) => {
    if (e.dataTransfer.types.includes(DRAG_TYPE)) e.preventDefault()
  }
  const dropItem = (e: DragEvent, to: RailContainer, before: RailItemRef | null) => {
    const drag = readDrag(e)
    if (drag?.kind !== 'item') return
    e.preventDefault()
    e.stopPropagation()
    commit(moveRailItemTo(rail, previous, drag.ref, to, before))
  }

  const itemRow = (entry: RailEntry, container: RailContainer) => {
    const target = entry.target
    if (!target || !shown(entry)) return null
    const label = target.kind === 'view' ? VIEW_LABELS[target.view] : target.page.label
    const pinned = container === 'pinned'
    return (
      <div
        key={entry.ref}
        draggable
        onDragStart={(e) => startDrag(e, { kind: 'item', ref: entry.ref })}
        onDragOver={allowDrop}
        onDrop={(e) => dropItem(e, container, entry.ref)}
        className={`flex items-center gap-1.5 pl-1 pr-0.5 py-0.5 rounded-sm text-[12.5px] text-text-2 hover:bg-layer-2 ${entry.hidden ? 'opacity-45' : ''}`}
      >
        <GripVertical size={13} className="shrink-0 text-text-3 cursor-grab" aria-hidden />
        <span className="shrink-0 flex items-center">
          {target.kind === 'view' ? <ViewIcon view={target.view} size={14} /> : <PageIcon name={target.page.icon} size={14} />}
        </span>
        <span className="truncate flex-1">{label}</span>
        <IconButton label={pinned ? `Unpin ${label}` : `Pin ${label}`} onClick={() => commit(setRailItemPinned(rail, previous, entry.ref, !pinned))}>
          {pinned ? <PinOff size={13} /> : <Pin size={13} />}
        </IconButton>
        <IconButton label={entry.hidden ? `Show ${label}` : `Hide ${label}`} onClick={() => commit(setRailHidden(rail, previous, entry.ref, !entry.hidden))}>
          {entry.hidden ? <EyeOff size={13} /> : <Eye size={13} />}
        </IconButton>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button type="button" aria-label={`More actions for ${label}`} className={ICON_BUTTON}>
              <MoreHorizontal size={13} />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent side="right" align="start">
            <DropdownMenuItem onSelect={() => commit(moveRailItemBy(rail, previous, entry.ref, -1))}>Move up</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => commit(moveRailItemBy(rail, previous, entry.ref, 1))}>Move down</DropdownMenuItem>
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>Move to</DropdownMenuSubTrigger>
              <DropdownMenuSubContent>
                {listSections.filter((s) => s.section.id !== container).map((s) => (
                  <DropdownMenuItem key={s.section.id} onSelect={() => commit(moveRailItemTo(rail, previous, entry.ref, s.section.id, null))}>
                    {s.section.label}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuSubContent>
            </DropdownMenuSub>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => commit(setRailItemPinned(rail, previous, entry.ref, !pinned))}>
              {pinned ? 'Unpin' : 'Pin to top'}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => commit(setRailHidden(rail, previous, entry.ref, !entry.hidden))}>
              {entry.hidden ? 'Show' : 'Hide'}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    )
  }

  const sectionBlock = (s: RailSectionEntry) => {
    const Icon = SECTION_ICONS[s.section.icon]
    const label = s.section.label
    const id = s.section.id
    return (
      <div key={id} className={s.hidden ? 'opacity-45' : ''}>
        <div
          draggable
          onDragStart={(e) => startDrag(e, { kind: 'section', id })}
          onDragOver={allowDrop}
          onDrop={(e) => {
            const drag = readDrag(e)
            if (!drag) return
            e.preventDefault()
            e.stopPropagation()
            // An entry dropped on a section header joins that section; a section dropped on it goes before it.
            if (drag.kind === 'item') {
              if (!s.section.direct) commit(moveRailItemTo(rail, previous, drag.ref, id, null))
              return
            }
            commit(moveRailSectionTo(rail, previous, drag.id, id))
          }}
          className="flex items-center gap-1.5 pl-1 pr-0.5 py-1 rounded-full text-[13px] font-600 text-text-2 hover:bg-layer-2"
        >
          <GripVertical size={13} className="shrink-0 text-text-3 cursor-grab" aria-hidden />
          <Icon size={16} />
          <span className="truncate flex-1">{label}</span>
          <IconButton label={s.hidden ? `Show ${label}` : `Hide ${label}`} onClick={() => commit(setRailHidden(rail, previous, sectionRef(id), !s.hidden))}>
            {s.hidden ? <EyeOff size={13} /> : <Eye size={13} />}
          </IconButton>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button type="button" aria-label={`More actions for ${label}`} className={ICON_BUTTON}>
                <MoreHorizontal size={13} />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent side="right" align="start">
              <DropdownMenuItem onSelect={() => commit(moveRailSectionBy(rail, previous, id, -1))}>Move up</DropdownMenuItem>
              <DropdownMenuItem onSelect={() => commit(moveRailSectionBy(rail, previous, id, 1))}>Move down</DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => commit(setRailHidden(rail, previous, sectionRef(id), !s.hidden))}>
                {s.hidden ? 'Show' : 'Hide'}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        {!s.section.direct && (
          <div
            className="ml-5 pl-1 mb-1 flex flex-col gap-0.5 border-l border-line-subtle"
            onDragOver={allowDrop}
            onDrop={(e) => dropItem(e, id, null)}
          >
            {s.entries.map((entry) => itemRow(entry, id))}
            {/* Room below the last row to drop an entry at the end of the section. */}
            <div className="h-2.5" aria-hidden />
          </div>
        )}
      </div>
    )
  }

  const pinnedShown = rail.pinned.some(shown)

  return (
    <div className="flex flex-col gap-0.5 px-3">
      <div className="mb-1" onDragOver={allowDrop} onDrop={(e) => dropItem(e, 'pinned', null)}>
        <div className="px-2 pb-1 text-[10px] font-700 uppercase tracking-[0.08em] text-text-3">Pinned</div>
        {pinnedShown ? rail.pinned.map((entry) => itemRow(entry, 'pinned')) : (
          <div className="mx-1 px-2 py-2 rounded-sm border border-dashed border-line-default text-[11px] text-text-3">
            Drag an entry here, or use its pin, to keep it at the top.
          </div>
        )}
      </div>

      {rail.sections.map(sectionBlock)}

      {rail.footer.map((s) => {
        const Icon = SECTION_ICONS[s.section.icon]
        return (
          <div key={s.section.id} className="mt-2">
            <div className="flex items-center gap-1.5 pl-6 pr-2 py-1 text-[13px] font-600 text-text-3">
              <Icon size={16} />
              <span className="truncate flex-1">{s.section.label}</span>
              <span className="text-[10px] font-600 uppercase tracking-[0.08em]">Fixed</span>
            </div>
          </div>
        )
      })}

      <div className="mt-3 flex items-center gap-2">
        <button
          type="button"
          onClick={() => setConfirmReset(true)}
          className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-full text-[12px] font-600 text-text-3 hover:text-text hover:bg-layer-2 border-none bg-transparent cursor-pointer"
          style={{ fontFamily: 'inherit' }}
        >
          <RotateCcw size={13} /> Reset
        </button>
        <button
          type="button"
          onClick={onDone}
          className="ml-auto flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[12px] font-600 text-accent-fg bg-accent-bright hover:brightness-110 border-none cursor-pointer"
          style={{ fontFamily: 'inherit' }}
        >
          <Check size={13} /> Done
        </button>
      </div>

      <ConfirmDialog
        open={confirmReset}
        title="Reset the sidebar?"
        message="Pinned entries, hidden entries and the order you set all go back to the default."
        confirmLabel="Reset"
        danger
        onConfirm={reset}
        onCancel={() => setConfirmReset(false)}
      />
    </div>
  )
}
```

If a class token used above does not exist in this project's Tailwind theme (check `src/app/globals.css` for `--color-surface`, `--color-layer-2`, `--color-line-default`, `--color-accent-fg`), use the nearest token the rail itself already uses; do not add new theme tokens.

- [ ] **Step 2: Wire it into the rail**

In `src/components/layout/sidebar-rail.tsx`:
- import `import { RailEditor } from '@/components/layout/rail-editor'` and `SlidersHorizontal` from `lucide-react`.
- add, next to the other state: `const [editing, setEditing] = useState(false)`
- change `const railExpanded = mobile || railExpandedStored` to:

```tsx
  // Mobile always forces expanded; so does edit mode, which needs the labels.
  const railExpanded = mobile || railExpandedStored || editing
  const isEditing = editing && !mobile
```

- widen the rail while editing — in the outer `div`'s className replace `${railExpanded ? 'w-[212px]' : 'w-[52px]'}` with `${railExpanded ? (isEditing ? 'w-[252px]' : 'w-[212px]') : 'w-[52px]'}`.
- hide the collapse button while editing: `{railExpanded && !mobile && !isEditing && (` for the logo row's toggle.
- in the scroll area, replace the main `<nav>` block from Task 5 with:

```tsx
        {isEditing ? (
          <RailEditor rail={rail} isViewEnabled={isViewEnabled} onDone={() => setEditing(false)} />
        ) : (
          <nav className={`flex flex-col gap-0.5 ${railExpanded ? 'px-3' : 'items-center'}`}>
            {/* the pinned rows and sections from Task 5, unchanged */}
          </nav>
        )}
```

- in the bottom block, render the footer sections only when not editing (the editor lists Settings itself) and add the entry button right before `<ThemeModeRailButton ... />`:

```tsx
          {!isEditing && (
            <nav className={`flex flex-col gap-0.5 ${railExpanded ? '' : 'items-center'}`}>
              {rail.footer.map(renderSection)}
            </nav>
          )}

          {!mobile && !isEditing && (railExpanded ? (
            <button
              onClick={() => setEditing(true)}
              className="w-full flex items-center gap-2.5 px-3 py-2 rounded-full text-[13px] font-600 cursor-pointer transition-all bg-transparent text-text-3 hover:text-text hover:bg-layer-2 border-none"
              style={{ fontFamily: 'inherit' }}
            >
              <SlidersHorizontal size={17} />
              <span className="truncate">Customize</span>
            </button>
          ) : (
            <RailTooltip label="Customize sidebar" description="Pin, hide and reorder what the sidebar shows">
              <button onClick={() => setEditing(true)} className="rail-btn" aria-label="Customize sidebar">
                <SlidersHorizontal size={17} />
              </button>
            </RailTooltip>
          ))}
```

- [ ] **Step 3: Verify**

Run: `npx tsc --noEmit -p .`
Expected: no errors.
Run: `npx eslint src/components/layout/rail-editor.tsx src/components/layout/sidebar-rail.tsx`
Expected: no issues.
Run: `npx tsx --test src/lib/app/rail-layout.test.ts src/lib/app/rail-layout-edit.test.ts src/lib/app/rail-state.test.ts`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/components/layout/rail-editor.tsx src/components/layout/sidebar-rail.tsx
git commit -m "Edit the rail in place: pin, hide, move and reorder, saved at once

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_013wE44gRcx8yMbNmXZyGJZL"
```

---

### Task 7: Documentation, spec notes, and the live check

**Files:**
- Modify: `CLAUDE.md` (extension page placement bullet)
- Modify: `doc/specs/2026-09-11-fulek-es-oldalsav-szerkeszto-design.md` (section 3: implementation notes)

**Interfaces:**
- Consumes: everything above.
- Produces: docs that match the shipped behaviour; a live-check record in the task report.

- [ ] **Step 1: CLAUDE.md**

In `CLAUDE.md`, in the "Writing an Extension" bullet that begins "A page in `ui.pages` picks its place in the rail with **`section`**", append after "every value resolves to `work`.":

```markdown
  `section` and `order` are only the default: the operator can pin, hide or
  move the page from the rail editor, which stores `appSettings.railLayout`
  (`src/lib/app/rail-layout.ts`). A page the stored layout does not mention
  still lands at the end of its declared section.
```

`AGENTS.md` is absent in this worktree; state in the report that the same text must go into the main checkout's `AGENTS.md` at merge.

- [ ] **Step 2: Spec notes**

At the end of section "3. Oldalsáv-szerkesztő" (before "## 4. Hibakezelés") add:

```markdown
### Megvalósítási megjegyzések

- A `RailItemRef` nézet-része szöveg (`view:${string}`), nem `AppView`: egy
  később megszűnő nézet ugyanúgy ártalmatlan tárolt hivatkozás marad, mint egy
  eltávolított bővítmény oldala.
- A közvetlen szekciókba (Home, Chat) nem kerül pont; az a bővítmény-oldal,
  amely ilyen szekciót ad meg, továbbra sem jelenik meg a railen (a mai
  viselkedés).
- A Settings szekció teljesen rögzített: a pontjai a sorrendjükkel együtt
  változatlanok, és más pont sem vihető bele.
- A mentés optimista; egymást követő mentéseknél csak a legutolsó válasza
  (vagy hibája) írja a store-t, hiba esetén az előző elrendezés tér vissza és
  értesítés jelenik meg.
- A rail „itt vagy” szekciója a feloldott elrendezést követi: az áthelyezett
  oldal az új szekcióját nyitja ki, a kitűzött pont a saját sorát emeli ki.
- A felirat angol, mint a rail többi szövege.
```

- [ ] **Step 3: Verify and commit**

Run: `npx tsx --test src/lib/app/rail-layout.test.ts src/lib/app/rail-layout-edit.test.ts src/lib/app/nav-sections.test.ts src/lib/app/palette-views.test.ts src/lib/app/view-icons.test.ts src/lib/app/tab-label.test.ts src/app/api/settings/settings-route.test.ts`
Expected: PASS.
Run: `npm run lint:baseline`
Expected: "No net-new lint issues detected".

```bash
git add CLAUDE.md doc/specs/2026-09-11-fulek-es-oldalsav-szerkeszto-design.md
git commit -m "Document the rail editor for extension authors, and note the choices made

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_013wE44gRcx8yMbNmXZyGJZL"
```

- [ ] **Step 4: Live check (controller, in a browser, against the isolated test server on 127.0.0.1:3901)**

The isolated dev server on port 3901 runs this worktree and hot-reloads. Do not start or stop any server. Record each result in the report:

1. Rail without a stored layout looks exactly as before (sections, CRM/Docs above their hairline, badges).
2. "Customize": every section opens, rows show handle / pin / eye / ⋯; Settings shows "Fixed".
3. Pin CRM (pin button) → CRM appears above the sections; on the collapsed (52px) rail it is an icon with a tooltip.
4. Hide Sessions (Agents › Sessions, eye) → faded in edit mode, gone after "Done"; ⌘K "Sessions" still opens it.
5. Move Docs to Operations by dragging, and Tasks to Knowledge with ⋯ › Move to; reorder a section with ⋯ › Move up.
6. Reload → all of the above persists (`GET /api/settings` shows `railLayout`).
7. Open `/x/docs` → Operations opens and lights; open `/x/crm` → the pinned row lights, no section.
8. In the tab host: click the pinned CRM row → the active tab navigates; Cmd-click → background tab.
9. `PUT /api/settings` with `{"railLayout":{"version":2}}` → 400 with `"field":"railLayout"`; the stored layout is unchanged.
10. "Reset" → confirm → default rail; `railLayout` gone from `GET /api/settings`.
11. At a width below 768 px, the drawer shows the resolved layout and no "Customize".
```
