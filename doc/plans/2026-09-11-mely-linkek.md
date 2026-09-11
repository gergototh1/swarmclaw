# Mélylinkek (Fülek 1. szakasz) — implementációs terv

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A CRM és a Doksik bővítmény-oldal a belső helyét (nézet, ügyfél, doksi) az URL-ben tartsa, a host adja át nekik az al-útvonalat és a címet; a Doksi-szerkesztő ne dobja el a függő mentést; a ⌘K paletta érje el a bővítmény-oldalakat.

**Architecture:** A `/x/[[...slug]]` route már most a prefix szerinti oldalra oldja fel a mély útvonalat. A route kiszámolja a `subPath`-ot, és három új propot ad az oldal-komponensnek (`subPath`, `navigate`, `setTitle`). A két bővítmény egy-egy tiszta `utvonal.ts` modullal képezi le a `subPath`-ot a saját állapotára, és régi host alatt helyi állapotra esik vissza. A Doksi autosave egy tiszta, időzítővel tesztelhető `autosave.ts`-be kerül.

**Tech Stack:** Next 16 App Router, React 19.2, TypeScript, `node:test` + `tsx`, esbuild (bővítmény-bundle).

**Spec:** `doc/specs/2026-09-11-fulek-es-oldalsav-szerkeszto-design.md` — „2. Bővítmény-oldalak helye az URL-ben, fülcímek”, plusz a paletta-bővítés az 1. részből.

## Global Constraints

- Nincs `any`; `unknown` vagy saját interfész. Lint-szabályt nem kapcsolunk ki.
- A host tesztjei a `package.json` `test:runtime` listájában futnak (`tsx --test ...`); új host-tesztfájlt oda kell felvenni.
- A bővítmény-tesztek: `cd extensions/<id> && npm test` (`node --import tsx --test test/*.test.mjs`); a `test:runtime` a bővítmények `test/*.test.mjs`-ét is futtatja.
- A root `tsconfig.json` az `extensions/**/ui/*.tsx`-et is típusellenőrzi: `npx tsc --noEmit`.
- A dev szervert (3456) leállítani/újraindítani TILOS a felhasználó engedélye nélkül.
- A `npm run install:local` az élő app adatkönyvtárába ír — futtatás előtt meg kell kérdezni a felhasználót, melyik példányba (dev szerver vagy asztali app).
- Minden commit üzenete a két trailerrel zárul:
  ```
  Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_013wE44gRcx8yMbNmXZyGJZL
  ```
- A régi, `subPath`-ot nem ismerő bundle-ök a mai módon működnek; az új bundle-ök régi host alatt helyi állapotra esnek vissza.

## Fájltérkép

| Fájl | Mi változik |
|---|---|
| `src/lib/extensions/page-location.ts` (új) | `extensionSubPath`, `extensionPageHref`, `pageDocumentTitle` — tiszta függvények |
| `src/lib/extensions/page-location.test.ts` (új) | a fenti tesztjei |
| `src/lib/extensions/registry.ts` | `ExtensionPageProps` interfész; `ExtensionPageComponent` erre épül |
| `src/app/x/[[...slug]]/page.tsx` | `subPath` / `navigate` / `setTitle` átadása |
| `src/lib/app/palette-extension-pages.ts` (új) | `extensionPageNavTargets` — tiszta |
| `src/lib/app/palette-extension-pages.test.ts` (új) | tesztje |
| `src/components/shared/command-palette.tsx` | bővítmény-oldalak a „nav” kategóriában |
| `package.json` | két új tesztfájl a `test:runtime`-ban |
| `CLAUDE.md`, `AGENTS.md` | egy pont a „Writing an Extension” alá (a kettő szinkronban) |
| `extensions/crm/ui/utvonal.ts` (új) | `helyAzUtbol`, `utAHelybol`, `alapHely` |
| `extensions/crm/test/utvonal.test.mjs` (új) | tesztje |
| `extensions/crm/ui/main.tsx` | nézet és nyitott ügyfél az URL-ből |
| `extensions/crm/ui/ugyfel-lap.tsx` | `onBetoltve` prop (cím a fülhöz) |
| `extensions/docs/ui/utvonal.ts` (új) | `doksiIdAzUtbol`, `utADoksihoz` |
| `extensions/docs/test/utvonal.test.mjs` (új) | tesztje |
| `extensions/docs/ui/main.tsx` | aktív doksi az URL-ből |
| `extensions/docs/ui/autosave.ts` (új) | `createAutosave` — tiszta, időzítős |
| `extensions/docs/test/autosave.test.mjs` (új) | tesztje (`mock.timers`) |
| `extensions/docs/ui/szerkeszto.tsx` | `onCim` prop; autosave flush lebontáskor és `pagehide`-kor |

---

### Task 1: Host — al-útvonal, navigate és cím az oldal-komponensnek

**Files:**
- Create: `src/lib/extensions/page-location.ts`
- Create: `src/lib/extensions/page-location.test.ts`
- Modify: `src/lib/extensions/registry.ts:25-26`
- Modify: `src/app/x/[[...slug]]/page.tsx` (importok; `ExtensionPageRoute` törzse)
- Modify: `package.json` (`test:runtime`)
- Modify: `CLAUDE.md`, `AGENTS.md` („Writing an Extension” szakasz)

**Interfaces:**
- Produces:
  - `extensionSubPath(pagePath: string, pathname: string): string` — `''` a gyökéren; vezető/záró `/` nélkül.
  - `extensionPageHref(pagePath: string, subPath: string): string`
  - `pageDocumentTitle(text: string | null, base: string): string`
  - `interface ExtensionPageProps { extensionId: string; rpc: ExtensionPageRpc; subPath: string; navigate: (subPath: string, opts?: { replace?: boolean }) => void; setTitle: (text: string | null) => void }`
  - `type ExtensionPageComponent = ComponentType<ExtensionPageProps>`

- [ ] **Step 1: Írd meg a bukó tesztet**

`src/lib/extensions/page-location.test.ts`:

```ts
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { extensionPageHref, extensionSubPath, pageDocumentTitle } from './page-location'

describe('extensionSubPath', () => {
  it('is empty at the page root', () => {
    assert.equal(extensionSubPath('/x/crm', '/x/crm'), '')
    assert.equal(extensionSubPath('/x/crm', '/x/crm/'), '')
  })

  it('returns the part below the declared path without slashes at either end', () => {
    assert.equal(extensionSubPath('/x/crm', '/x/crm/ugyfelek/a1'), 'ugyfelek/a1')
    assert.equal(extensionSubPath('/x/crm', '/x/crm/ugyek/'), 'ugyek')
  })

  it('does not treat a longer sibling slug as a sub path', () => {
    assert.equal(extensionSubPath('/x/crm', '/x/crmx/a'), '')
  })
})

describe('extensionPageHref', () => {
  it('is the page path for an empty sub path', () => {
    assert.equal(extensionPageHref('/x/crm', ''), '/x/crm')
  })

  it('joins a sub path with exactly one slash', () => {
    assert.equal(extensionPageHref('/x/crm', 'ugyfelek/a1'), '/x/crm/ugyfelek/a1')
    assert.equal(extensionPageHref('/x/crm', '/ugyek/'), '/x/crm/ugyek')
  })
})

describe('pageDocumentTitle', () => {
  it('keeps the base title when the page names nothing', () => {
    assert.equal(pageDocumentTitle(null, 'SidekickOS'), 'SidekickOS')
    assert.equal(pageDocumentTitle('   ', 'SidekickOS'), 'SidekickOS')
  })

  it('puts the page title in front of the base title', () => {
    assert.equal(pageDocumentTitle('CRM · Kovács Kft', 'SidekickOS'), 'CRM · Kovács Kft · SidekickOS')
  })
})
```

- [ ] **Step 2: Futtasd, hogy lásd bukni**

Run: `npx tsx --test src/lib/extensions/page-location.test.ts`
Expected: FAIL — `Cannot find module './page-location'`.

- [ ] **Step 3: Implementáld**

`src/lib/extensions/page-location.ts`:

```ts
/**
 * Where inside its own page an extension page is standing.
 *
 * The `/x/[[...slug]]` route already resolves `/x/crm/ugyfelek/a1` to the page
 * declared at `/x/crm`. These helpers hand the remainder to the page and build
 * the URL back from it, so an extension can keep its location in the address
 * bar — which is what lets a reload, a bookmark or (later) a tab return to it.
 */

function trimSlashes(value: string): string {
  return value.replace(/^\/+|\/+$/g, '')
}

/** The part of `pathname` below `pagePath`, without slashes at either end; '' at the page root. */
export function extensionSubPath(pagePath: string, pathname: string): string {
  if (!pathname.startsWith(`${pagePath}/`)) return ''
  return trimSlashes(pathname.slice(pagePath.length + 1))
}

/** The URL of `subPath` inside the page declared at `pagePath`. */
export function extensionPageHref(pagePath: string, subPath: string): string {
  const rest = trimSlashes(subPath)
  return rest ? `${pagePath}/${rest}` : pagePath
}

/** The document title while an extension page names what it is showing. */
export function pageDocumentTitle(text: string | null, base: string): string {
  const trimmed = text?.trim()
  return trimmed ? `${trimmed} · ${base}` : base
}
```

- [ ] **Step 4: Vedd fel a tesztet a `test:runtime`-ba és futtasd**

A `package.json` `test:runtime` sorában a `src/lib/extensions/registry.test.ts` után szúrd be: ` src/lib/extensions/page-location.test.ts` (Edit tool, `old_string`: `src/lib/extensions/registry.test.ts src/lib/extensions/duplicate-react.test.ts`, `new_string`: `src/lib/extensions/registry.test.ts src/lib/extensions/page-location.test.ts src/lib/extensions/duplicate-react.test.ts`).

Run: `npx tsx --test src/lib/extensions/page-location.test.ts`
Expected: PASS, 7 teszt.

- [ ] **Step 5: Bővítsd a registry típusát**

`src/lib/extensions/registry.ts` — cseréld le ezt:

```ts
/** The component an extension bundle registers for one of its declared pages. */
export type ExtensionPageComponent = ComponentType<{ extensionId: string; rpc: ExtensionPageRpc }>
```

erre:

```ts
/**
 * What the page renderer hands an extension's page component.
 *
 * `subPath`, `navigate` and `setTitle` arrived after the first two; a bundle
 * built before them simply ignores them and keeps working.
 */
export interface ExtensionPageProps {
  extensionId: string
  rpc: ExtensionPageRpc
  /** The path below the page's declared `path`, without slashes at either end; '' at the page root. */
  subPath: string
  /** Move to `subPath` inside this same page. The component stays mounted. */
  navigate: (subPath: string, opts?: { replace?: boolean }) => void
  /** Name what the page is showing, e.g. "CRM · Kovács Kft"; null goes back to the plain title. */
  setTitle: (text: string | null) => void
}

/** The component an extension bundle registers for one of its declared pages. */
export type ExtensionPageComponent = ComponentType<ExtensionPageProps>
```

- [ ] **Step 6: Add át a propokat a route-ban**

`src/app/x/[[...slug]]/page.tsx`:

Importok — cseréld:

```ts
import { Component, useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { usePathname } from 'next/navigation'
```

erre:

```ts
import { Component, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { usePathname, useRouter } from 'next/navigation'
```

és a registry-import alá vedd fel:

```ts
import { extensionPageHref, extensionSubPath, pageDocumentTitle } from '@/lib/extensions/page-location'
```

Az `ExtensionPageRoute` elején a `const pathname = usePathname()` alá:

```ts
  const router = useRouter()
```

A `const rpc = useCallback(...)` blokk UTÁN (még a `if (!page)` előtt — a hookok sorrendje miatt):

```ts
  const pagePath = page?.path
  const subPath = pagePath ? extensionSubPath(pagePath, pathname) : ''

  // Push by default so the browser's back button walks the page's own history.
  const navigate = useCallback((next: string, opts?: { replace?: boolean }) => {
    if (!pagePath) return
    const href = extensionPageHref(pagePath, next)
    if (opts?.replace) router.replace(href)
    else router.push(href)
  }, [router, pagePath])

  // The title the app had before any page named itself, captured on first use
  // so that null — and leaving the page — can put it back.
  const baseTitle = useRef<string | null>(null)
  const setTitle = useCallback((text: string | null) => {
    if (baseTitle.current === null) baseTitle.current = document.title
    document.title = pageDocumentTitle(text, baseTitle.current)
  }, [])
  useEffect(() => () => {
    if (baseTitle.current !== null) document.title = baseTitle.current
  }, [extensionId, pageId])
```

A renderelésben cseréld:

```tsx
          <ExtensionComponent extensionId={page.extensionId} rpc={rpc} />
```

erre:

```tsx
          <ExtensionComponent
            extensionId={page.extensionId}
            rpc={rpc}
            subPath={subPath}
            navigate={navigate}
            setTitle={setTitle}
          />
```

- [ ] **Step 7: Dokumentáld a propokat**

`CLAUDE.md` ÉS `AGENTS.md` „Writing an Extension” szakaszában, a „A page in `ui.pages` picks its place in the rail with **`section**`…” pont UTÁN vedd fel ugyanezt a pontot (mindkét fájlba szó szerint):

```markdown
- A page component receives `{ extensionId, rpc, subPath, navigate, setTitle }`.
  `subPath` is the URL below the page's declared `path` (`/x/crm/ugyfelek/a1`
  → `ugyfelek/a1`), `navigate(subPath)` moves within the page without
  remounting it, and `setTitle(text)` names what it shows. Keep a page's
  location in `subPath` rather than in `useState`: that is what lets a reload,
  a bookmark or a tab come back to it. Fall back to local state when `navigate`
  is absent, so the bundle still works on an older host.
```

- [ ] **Step 8: Típusellenőrzés és tesztek**

Run: `npx tsc --noEmit`
Expected: nincs új hiba.

Run: `npx tsx --test src/lib/extensions/page-location.test.ts src/lib/extensions/registry.test.ts`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/lib/extensions/page-location.ts src/lib/extensions/page-location.test.ts src/lib/extensions/registry.ts "src/app/x/[[...slug]]/page.tsx" package.json CLAUDE.md AGENTS.md
git commit -F - <<'EOF'
Hand extension pages their sub path, a navigate and a title

The /x route already resolved /x/crm/<anything> to the CRM page but dropped
the remainder. Pages now get it as subPath, with navigate() to move inside
the page and setTitle() to name what they show, so a page can keep its
location in the URL.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_013wE44gRcx8yMbNmXZyGJZL
EOF
```

---

### Task 2: A ⌘K paletta a bővítmény-oldalakat is listázza

**Files:**
- Create: `src/lib/app/palette-extension-pages.ts`
- Create: `src/lib/app/palette-extension-pages.test.ts`
- Modify: `src/components/shared/command-palette.tsx` (importok; `CommandPaletteInner` hookjai; az `items` memo)
- Modify: `package.json` (`test:runtime`)

**Interfaces:**
- Consumes: `ExtensionPage` (`@/hooks/use-extension-pages`), `useExtensionPages()`.
- Produces: `extensionPageNavTargets(pages: readonly ExtensionPage[]): PaletteNavTarget[]`, `interface PaletteNavTarget { id: string; label: string; description: string; keywords: string[]; href: string }`.

- [ ] **Step 1: Írd meg a bukó tesztet**

`src/lib/app/palette-extension-pages.test.ts`:

```ts
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { ExtensionPage } from '@/hooks/use-extension-pages'
import { extensionPageNavTargets } from './palette-extension-pages'

const page = (extensionId: string, id: string, label: string, path: string): ExtensionPage => ({
  extensionId, id, label, path, entry: 'dist/index.js',
})

describe('extensionPageNavTargets', () => {
  it('offers every extension page as a palette destination at its declared path', () => {
    const targets = extensionPageNavTargets([page('crm.mjs', 'crm', 'CRM', '/x/crm')])
    assert.deepEqual(targets, [{
      id: 'nav:x:crm.mjs:crm',
      label: 'Go to CRM',
      description: 'Extension page',
      keywords: ['CRM', 'crm.mjs', 'crm'],
      href: '/x/crm',
    }])
  })

  it('lists them by label so the order does not depend on install order', () => {
    const targets = extensionPageNavTargets([
      page('video.mjs', 'video', 'Videó', '/x/video'),
      page('docs.mjs', 'docs', 'Doksik', '/x/docs'),
    ])
    assert.deepEqual(targets.map((t) => t.href), ['/x/docs', '/x/video'])
  })
})
```

- [ ] **Step 2: Futtasd, hogy lásd bukni**

Run: `npx tsx --test src/lib/app/palette-extension-pages.test.ts`
Expected: FAIL — `Cannot find module './palette-extension-pages'`.

- [ ] **Step 3: Implementáld**

`src/lib/app/palette-extension-pages.ts`:

```ts
import type { ExtensionPage } from '@/hooks/use-extension-pages'

/** One palette destination an extension page contributes. */
export interface PaletteNavTarget {
  id: string
  label: string
  description: string
  keywords: string[]
  href: string
}

/**
 * Extension pages as ⌘K destinations.
 *
 * The palette listed only built-in views, so a page reachable from the rail
 * alone became unreachable the moment the rail stopped showing it.
 */
export function extensionPageNavTargets(pages: readonly ExtensionPage[]): PaletteNavTarget[] {
  return [...pages]
    .sort((a, b) => a.label.localeCompare(b.label))
    .map((p) => ({
      id: `nav:x:${p.extensionId}:${p.id}`,
      label: `Go to ${p.label}`,
      description: 'Extension page',
      keywords: [p.label, p.extensionId, p.id],
      href: p.path,
    }))
}
```

- [ ] **Step 4: Vedd fel a `test:runtime`-ba, futtasd**

`package.json` `test:runtime`: `old_string` `src/lib/app/view-constants.test.ts src/lib/app/navigation.test.ts`, `new_string` `src/lib/app/view-constants.test.ts src/lib/app/navigation.test.ts src/lib/app/palette-extension-pages.test.ts`.

Run: `npx tsx --test src/lib/app/palette-extension-pages.test.ts`
Expected: PASS, 2 teszt.

- [ ] **Step 5: Kösd be a palettába**

`src/components/shared/command-palette.tsx` importjai közé:

```ts
import { useRouter } from 'next/navigation'
import { useExtensionPages } from '@/hooks/use-extension-pages'
import { extensionPageNavTargets } from '@/lib/app/palette-extension-pages'
```

(Ha a fájl már importál a `next/navigation`-ből, a `useRouter`-t abba az importba vedd fel.)

A `CommandPaletteInner`-ben a `const navigateTo = useNavigate()` alá:

```ts
  const router = useRouter()
  const extensionPages = useExtensionPages()
```

Az `items` memóban a `for (const view of views) { ... }` ciklus UTÁN:

```ts
    for (const target of extensionPageNavTargets(extensionPages)) {
      result.push({
        id: target.id,
        label: target.label,
        description: target.description,
        keywords: target.keywords,
        category: 'nav',
        onSelect: () => { router.push(target.href); setOpen(false) },
      })
    }
```

és a memo függőségi listájába vedd fel: `extensionPages, router`.

- [ ] **Step 6: Típus és lint**

Run: `npx tsc --noEmit && npx eslint src/components/shared/command-palette.tsx src/lib/app/palette-extension-pages.ts src/lib/app/palette-extension-pages.test.ts`
Expected: nincs hiba.

- [ ] **Step 7: Commit**

```bash
git add src/lib/app/palette-extension-pages.ts src/lib/app/palette-extension-pages.test.ts src/components/shared/command-palette.tsx package.json
git commit -F - <<'EOF'
List extension pages in the command palette

The palette only knew built-in views, so CRM, Docs and the other extension
pages could be reached from the rail alone.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_013wE44gRcx8yMbNmXZyGJZL
EOF
```

---

### Task 3: CRM — nézet és nyitott ügyfél az URL-ben

**Files:**
- Create: `extensions/crm/ui/utvonal.ts`
- Create: `extensions/crm/test/utvonal.test.mjs`
- Modify: `extensions/crm/ui/main.tsx` (egész `CrmPage`, a `Nezet` típus kikerül)
- Modify: `extensions/crm/ui/ugyfel-lap.tsx:115` (props) és `:131-134` (`tolt`)

**Interfaces:**
- Consumes: a Task 1 `ExtensionPageProps` alakja (a bővítmény saját, opcionális típusként deklarálja — nem importál a hostból).
- Produces:
  - `type Nezet = 'ma' | 'ugyfelek' | 'ugyek'`
  - `type CrmHely = { nezet: 'ma' } | { nezet: 'ugyfelek'; accountId: string | null } | { nezet: 'ugyek' }`
  - `helyAzUtbol(subPath: string): CrmHely`, `utAHelybol(hely: CrmHely): string`, `alapHely(nezet: Nezet): CrmHely`

URL-térkép: `''` → Ma · `ugyfelek` → lista · `ugyfelek/<accountId>` → ügyféllap · `ugyek` → ügyek · bármi más → Ma.

Viselkedésváltozás, szándékos: a „Ügyfelek” fülre kattintás mostantól a listára visz akkor is, ha előtte egy ügyféllap volt nyitva (a vissza gomb visz vissza a laphoz).

- [ ] **Step 1: Írd meg a bukó tesztet**

`extensions/crm/test/utvonal.test.mjs`:

```js
import assert from 'node:assert/strict'
import test from 'node:test'

import { alapHely, helyAzUtbol, utAHelybol } from '../ui/utvonal.ts'

test('a gyökér a Ma nézet', () => {
  assert.deepEqual(helyAzUtbol(''), { nezet: 'ma' })
})

test('ismeretlen útvonal a Ma nézetre esik vissza, nem üres lapra', () => {
  assert.deepEqual(helyAzUtbol('nincs-ilyen/x'), { nezet: 'ma' })
})

test('a lista és az ügyek saját útvonalat kapnak', () => {
  assert.deepEqual(helyAzUtbol('ugyfelek'), { nezet: 'ugyfelek', accountId: null })
  assert.deepEqual(helyAzUtbol('ugyek'), { nezet: 'ugyek' })
})

test('az ügyféllap az ügyfél azonosítóját hordozza, kódolva is', () => {
  assert.deepEqual(helyAzUtbol('ugyfelek/acc_1'), { nezet: 'ugyfelek', accountId: 'acc_1' })
  assert.deepEqual(helyAzUtbol('ugyfelek/a%20b'), { nezet: 'ugyfelek', accountId: 'a b' })
})

test('hibás kódolás a listára visz, nem dob', () => {
  assert.deepEqual(helyAzUtbol('ugyfelek/%E0%A4%A'), { nezet: 'ugyfelek', accountId: null })
})

test('oda-vissza: minden hely ugyanarra az útvonalra képződik, amiből jött', () => {
  for (const ut of ['', 'ugyfelek', 'ugyfelek/acc_1', 'ugyfelek/a%20b', 'ugyek']) {
    assert.equal(utAHelybol(helyAzUtbol(ut)), ut)
  }
})

test('a fülek a nézet gyökerére visznek', () => {
  assert.deepEqual(alapHely('ma'), { nezet: 'ma' })
  assert.deepEqual(alapHely('ugyfelek'), { nezet: 'ugyfelek', accountId: null })
  assert.deepEqual(alapHely('ugyek'), { nezet: 'ugyek' })
})
```

- [ ] **Step 2: Futtasd, hogy lásd bukni**

Run: `cd extensions/crm && node --import tsx --test test/utvonal.test.mjs`
Expected: FAIL — a `../ui/utvonal.ts` nem található.

- [ ] **Step 3: Implementáld**

`extensions/crm/ui/utvonal.ts`:

```ts
/**
 * A CRM helye az URL-ben.
 *
 * A nézet és a nyitott ügyfél korábban `useState` volt: elnavigálás után a
 * lap lebomlott, és visszatérve a Ma nézet fogadott, bármi volt is nyitva.
 * Az URL-ben tartva az újratöltés, a könyvjelző és a fül is oda tér vissza.
 *
 *   ''                     -> Ma
 *   'ugyfelek'             -> ügyféllista
 *   'ugyfelek/<accountId>' -> ügyféllap
 *   'ugyek'                -> ügyek
 *
 * Minden más a Ma nézet: egy elírt vagy elavult link is működő lapra visz.
 */

export type Nezet = 'ma' | 'ugyfelek' | 'ugyek'

export type CrmHely =
  | { nezet: 'ma' }
  | { nezet: 'ugyfelek'; accountId: string | null }
  | { nezet: 'ugyek' }

export function helyAzUtbol(subPath: string): CrmHely {
  const [elso, masodik] = subPath.split('/').filter(Boolean)
  if (elso === 'ugyek') return { nezet: 'ugyek' }
  if (elso !== 'ugyfelek') return { nezet: 'ma' }
  if (!masodik) return { nezet: 'ugyfelek', accountId: null }
  try {
    return { nezet: 'ugyfelek', accountId: decodeURIComponent(masodik) }
  } catch {
    return { nezet: 'ugyfelek', accountId: null }
  }
}

export function utAHelybol(hely: CrmHely): string {
  if (hely.nezet === 'ugyek') return 'ugyek'
  if (hely.nezet === 'ugyfelek') {
    return hely.accountId ? `ugyfelek/${encodeURIComponent(hely.accountId)}` : 'ugyfelek'
  }
  return ''
}

/** Egy fül a nézete gyökerére visz: az Ügyfelek fül a listára, nem egy korábban nyitott lapra. */
export function alapHely(nezet: Nezet): CrmHely {
  return nezet === 'ugyfelek' ? { nezet, accountId: null } : { nezet }
}
```

- [ ] **Step 4: Futtasd, hogy lásd átmenni**

Run: `cd extensions/crm && node --import tsx --test test/utvonal.test.mjs`
Expected: PASS, 7 teszt.

- [ ] **Step 5: `UgyfelLap` jelezze az ügyfél nevét**

`extensions/crm/ui/ugyfel-lap.tsx` — a szignatúra:

```tsx
export function UgyfelLap({ rpc, accountId, onBack }: { rpc: Rpc; accountId: string; onBack: () => void }) {
```

helyett:

```tsx
export function UgyfelLap({ rpc, accountId, onBack, onBetoltve }: {
  rpc: Rpc
  accountId: string
  onBack: () => void
  /** Az ügyfél neve minden sikeres betöltés után -- a fül és az ablak címéhez. */
  onBetoltve?: (nev: string) => void
}) {
```

és a `tolt`-ban a `setLap(x as Lap)` sor helyett:

```tsx
        const betoltott = x as Lap
        setLap(betoltott)
        onBetoltve?.(betoltott.account.name)
```

- [ ] **Step 6: `CrmPage` az URL-ből dolgozzon**

`extensions/crm/ui/main.tsx`:

Az első import sor helyett:

```tsx
import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
```

A helyi `type Nezet = 'ma' | 'ugyfelek' | 'ugyek'` sort töröld, és az importok közé vedd fel:

```tsx
import { alapHely, helyAzUtbol, utAHelybol, type CrmHely, type Nezet } from './utvonal'
```

Az `export function CrmPage(...)` sort és az utána álló két `useState` sort (`nezet`, `nyitottAccount`) cseréld erre:

```tsx
/**
 * Amit a host ad a lapnak. A `subPath`, `navigate` és `setTitle` újabb hostnál
 * érkezik; régebbi alatt hiányzik, és a lap helyi állapotból dolgozik tovább.
 */
type OldalProps = {
  extensionId: string
  rpc: Rpc
  subPath?: string
  navigate?: (subPath: string, opts?: { replace?: boolean }) => void
  setTitle?: (text: string | null) => void
}

export function CrmPage({ rpc, subPath, navigate, setTitle }: OldalProps) {
  const [helyiUt, setHelyiUt] = useState('')
  const hely = helyAzUtbol(subPath ?? helyiUt)
  const nezet = hely.nezet
  const nyitottAccount = hely.nezet === 'ugyfelek' ? hely.accountId : null
  const menj = (uj: CrmHely) => {
    const ut = utAHelybol(uj)
    if (navigate) navigate(ut)
    else setHelyiUt(ut)
  }

  // Ügyféllap nélkül a cím a sima CRM; a lapon a betöltött név adja (lásd lent).
  useEffect(() => { if (!nyitottAccount) setTitle?.(null) }, [nyitottAccount, setTitle])
```

A `fulsav` ref sora marad. A `nyilra`-ban:

```tsx
    setNezet(NEZETEK[cel].id)
```

helyett:

```tsx
    menj(alapHely(NEZETEK[cel].id))
```

A fülgombon:

```tsx
                    onClick={() => setNezet(f.id)}>{f.cimke}</button>
```

helyett:

```tsx
                    onClick={() => menj(alapHely(f.id))}>{f.cimke}</button>
```

A `<main>` tartalmát:

```tsx
        {nezet === 'ma' && <MaNezet rpc={rpc} onOpen={(id) => { setNyitottAccount(id); setNezet('ugyfelek') }} />}
        {nezet === 'ugyfelek' && (nyitottAccount
          ? <UgyfelLap rpc={rpc} accountId={nyitottAccount} onBack={() => setNyitottAccount(null)} />
          : <UgyfelekNezet rpc={rpc} onOpen={setNyitottAccount} />)}
        {nezet === 'ugyek' && <UgyekNezet rpc={rpc} />}
```

erre:

```tsx
        {nezet === 'ma' && <MaNezet rpc={rpc} onOpen={(id) => menj({ nezet: 'ugyfelek', accountId: id })} />}
        {nezet === 'ugyfelek' && (nyitottAccount
          ? <UgyfelLap
              key={nyitottAccount}
              rpc={rpc}
              accountId={nyitottAccount}
              onBack={() => menj({ nezet: 'ugyfelek', accountId: null })}
              onBetoltve={(nev) => setTitle?.(`CRM · ${nev}`)}
            />
          : <UgyfelekNezet rpc={rpc} onOpen={(id) => menj({ nezet: 'ugyfelek', accountId: id })} />)}
        {nezet === 'ugyek' && <UgyekNezet rpc={rpc} />}
```

(A `key={nyitottAccount}`: ha a vissza gomb egyik ügyfélről a másikra visz, a lap új állapottal indul, nem az előző ügyfél félkész űrlapjaival.)

- [ ] **Step 7: Tesztek, típus, build**

Run: `cd extensions/crm && npm test`
Expected: minden PASS (a `ui.test.mjs` a bundle-t is lefordítja).

Run: `npx tsc --noEmit` (a repo gyökerében)
Expected: nincs hiba.

- [ ] **Step 8: Commit**

```bash
git add extensions/crm/ui/utvonal.ts extensions/crm/test/utvonal.test.mjs extensions/crm/ui/main.tsx extensions/crm/ui/ugyfel-lap.tsx
git commit -F - <<'EOF'
Keep the CRM's view and open customer in the URL

/x/crm/ugyfelek/<id> now opens that customer's sheet, so a reload or a
return from another module lands where it was instead of on Today. The
sheet names the customer in the window title.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_013wE44gRcx8yMbNmXZyGJZL
EOF
```

---

### Task 4: Doksik — a nyitott doksi az URL-ben

**Files:**
- Create: `extensions/docs/ui/utvonal.ts`
- Create: `extensions/docs/test/utvonal.test.mjs`
- Modify: `extensions/docs/ui/main.tsx` (`DocsPage` szignatúra, `aktivId` állapot, `Szerkeszto` hívás)
- Modify: `extensions/docs/ui/szerkeszto.tsx:69-79` (props), `:99-119` (betöltés), `:144-161` (`mentCim`)

**Interfaces:**
- Produces: `doksiIdAzUtbol(subPath: string): string | null`, `utADoksihoz(id: string | null): string`; `Szerkeszto` új opcionális propja: `onCim?: (cim: string | null) => void`.

A doksi-azonosítók ma `doc_<8 hex>` alakúak (`extensions/docs/src/vault.mjs` `newDocId`), de a kód nem épít erre: kódol és dekódol.

- [ ] **Step 1: Írd meg a bukó tesztet**

`extensions/docs/test/utvonal.test.mjs`:

```js
import assert from 'node:assert/strict'
import test from 'node:test'

import { doksiIdAzUtbol, utADoksihoz } from '../ui/utvonal.ts'

test('a gyökéren nincs nyitott doksi', () => {
  assert.equal(doksiIdAzUtbol(''), null)
  assert.equal(utADoksihoz(null), '')
})

test('az első szegmens a doksi azonosítója', () => {
  assert.equal(doksiIdAzUtbol('doc_1a2b3c4d'), 'doc_1a2b3c4d')
  assert.equal(doksiIdAzUtbol('doc_1a2b3c4d/'), 'doc_1a2b3c4d')
})

test('oda-vissza kódol, ha az azonosító nem URL-biztos', () => {
  assert.equal(utADoksihoz('a/b c'), 'a%2Fb%20c')
  assert.equal(doksiIdAzUtbol(utADoksihoz('a/b c')), 'a/b c')
})

test('hibás kódolásnál nincs nyitott doksi, nem dob', () => {
  assert.equal(doksiIdAzUtbol('%E0%A4%A'), null)
})
```

- [ ] **Step 2: Futtasd, hogy lásd bukni**

Run: `cd extensions/docs && node --import tsx --test test/utvonal.test.mjs`
Expected: FAIL — a `../ui/utvonal.ts` nem található.

- [ ] **Step 3: Implementáld**

`extensions/docs/ui/utvonal.ts`:

```ts
/**
 * The open document's place in the URL: `/x/docs/<docId>`.
 *
 * It used to be `useState`, so leaving the page and coming back showed an
 * empty editor whatever had been open. Kept in the URL, a reload, a bookmark
 * or a tab reopens the same document.
 */

export function doksiIdAzUtbol(subPath: string): string | null {
  const szegmens = subPath.split('/').filter(Boolean)[0]
  if (!szegmens) return null
  try {
    return decodeURIComponent(szegmens)
  } catch {
    return null
  }
}

export function utADoksihoz(id: string | null): string {
  return id ? encodeURIComponent(id) : ''
}
```

- [ ] **Step 4: Futtasd, hogy lásd átmenni**

Run: `cd extensions/docs && node --import tsx --test test/utvonal.test.mjs`
Expected: PASS, 4 teszt.

- [ ] **Step 5: `Szerkeszto` jelezze a doksi címét**

`extensions/docs/ui/szerkeszto.tsx` — a props-listában az `onCimFokuszalva` után:

```tsx
export function Szerkeszto({ rpc, id, cimek, onMentve, panelNyitva, onPanelValt, onTorol, fokuszCim, onCimFokuszalva, onCim }: {
  rpc: Rpc
  id: string | null
  cimek: Set<string>
  onMentve: () => void
  panelNyitva: boolean
  onPanelValt: () => void
  onTorol: () => void
  fokuszCim: boolean
  onCimFokuszalva: () => void
  /** A nyitott doksi címe betöltéskor és átnevezés után; null, ha nincs nyitott doksi. */
  onCim?: (cim: string | null) => void
}) {
```

A betöltő effektben:

```tsx
    if (!id || !editor) { setDoc(null); return }
```

helyett:

```tsx
    if (!id || !editor) { setDoc(null); onCim?.(null); return }
```

a `setCim(loaded.cim)` sor után:

```tsx
        onCim?.(loaded.cim)
```

és a függőségi lista `[id, editor, rpc]` helyett `[id, editor, rpc, onCim]` (a meglévő `eslint-disable-next-line` komment a `cimek` miatt marad).

A `mentCim`-ben a `setDoc((elozo) => ...)` sor után:

```tsx
        onCim?.(tiszta)
```

és a `useCallback` függőségi listájába vedd fel az `onCim`-et.

- [ ] **Step 6: `DocsPage` az URL-ből dolgozzon**

`extensions/docs/ui/main.tsx` — az importok közé:

```tsx
import { doksiIdAzUtbol, utADoksihoz } from './utvonal'
```

A `export function DocsPage({ rpc }: { extensionId: string; rpc: Rpc }) {` sort cseréld erre:

```tsx
/**
 * What the host hands the page. `subPath`, `navigate` and `setTitle` arrive
 * from a newer host; on an older one they are absent and the page falls back
 * to local state.
 */
type OldalProps = {
  extensionId: string
  rpc: Rpc
  subPath?: string
  navigate?: (subPath: string, opts?: { replace?: boolean }) => void
  setTitle?: (text: string | null) => void
}

export function DocsPage({ rpc, subPath, navigate, setTitle }: OldalProps) {
```

A `const [aktivId, setAktivId] = useState<string | null>(null)` sort cseréld erre:

```tsx
  const [helyiUt, setHelyiUt] = useState('')
  const aktivId = doksiIdAzUtbol(subPath ?? helyiUt)
  const setAktivId = useCallback((id: string | null) => {
    const ut = utADoksihoz(id)
    if (navigate) navigate(ut)
    else setHelyiUt(ut)
  }, [navigate])
  const cimJelzes = useCallback((cim: string | null) => {
    setTitle?.(cim ? `Doksik · ${cim}` : null)
  }, [setTitle])
```

A `torol` `useCallback` függőségi listáját `[aktivId, rpc, refresh]`-ről `[aktivId, rpc, refresh, setAktivId]`-re bővítsd.

A `<Szerkeszto ... />` hívásba vedd fel:

```tsx
          onCim={cimJelzes}
```

- [ ] **Step 7: Tesztek, típus, lint**

Run: `cd extensions/docs && npm test`
Expected: minden PASS.

Run: `npx tsc --noEmit && npx eslint extensions/docs/ui/main.tsx extensions/docs/ui/szerkeszto.tsx extensions/docs/ui/utvonal.ts` (a repo gyökerében)
Expected: nincs hiba.

- [ ] **Step 8: Commit**

```bash
git add extensions/docs/ui/utvonal.ts extensions/docs/test/utvonal.test.mjs extensions/docs/ui/main.tsx extensions/docs/ui/szerkeszto.tsx
git commit -F - <<'EOF'
Keep the open document in the Docs page's URL

/x/docs/<docId> opens that document, so coming back to Docs reopens what
was open instead of an empty editor. The document's title goes to the
window title and follows a rename.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_013wE44gRcx8yMbNmXZyGJZL
EOF
```

---

### Task 5: Doksik — a függő mentés ne vesszen el

**A hiba:** `szerkeszto.tsx` autosave-effektje lebontáskor `clearTimeout`-tal eldobja a függő mentést, így az utolsó 800 ms gépelése elvész doksiváltáskor és elnavigáláskor. Mivel az effekt a `verzio`-tól és a `ment`-től is függ, egy folyamatban lévő mentés visszaigazolása (`verzio` változik) is eldobja a közben gépelt szöveg időzítőjét.

**A javítás:** az időzítő egy tiszta `createAutosave`-be kerül. Az effekt csak `[editor, id]`-re épül újra; a `verzio`-t és a `ment`-et ref-ből olvassa; lebontáskor és `pagehide`-kor a függő mentést lefuttatja (`flushPending`), nem eldobja.

**Files:**
- Create: `extensions/docs/ui/autosave.ts`
- Create: `extensions/docs/test/autosave.test.mjs`
- Modify: `extensions/docs/ui/szerkeszto.tsx:85` (a `timer` ref törlése), `:174-187` (autosave-effekt)
- Modify: `doc/specs/2026-09-11-fulek-es-oldalsav-szerkeszto-design.md` (a „Hibajavítás” bekezdés)

**Interfaces:**
- Produces: `createAutosave(opts: { delayMs: number; read: () => string; saved: () => string; save: (md: string) => void }): Autosave`, `interface Autosave { schedule(): void; flushPending(): void; cancel(): void }`.

- [ ] **Step 1: Írd meg a bukó tesztet**

`extensions/docs/test/autosave.test.mjs`:

```js
import assert from 'node:assert/strict'
import { beforeEach, afterEach, mock, test } from 'node:test'

import { createAutosave } from '../ui/autosave.ts'

beforeEach(() => mock.timers.enable({ apis: ['setTimeout'] }))
afterEach(() => mock.timers.reset())

function harness(initial = 'régi') {
  const state = { text: initial, saved: initial, saves: [] }
  const autosave = createAutosave({
    delayMs: 800,
    read: () => state.text,
    saved: () => state.saved,
    save: (md) => { state.saves.push(md); state.saved = md },
  })
  return { state, autosave }
}

test('a csend lejártakor ment, egyszer', () => {
  const { state, autosave } = harness()
  state.text = 'új'
  autosave.schedule()
  mock.timers.tick(799)
  assert.deepEqual(state.saves, [])
  mock.timers.tick(1)
  assert.deepEqual(state.saves, ['új'])
})

test('minden szerkesztés újraindítja a visszaszámlálást', () => {
  const { state, autosave } = harness()
  state.text = 'ú'
  autosave.schedule()
  mock.timers.tick(500)
  state.text = 'új'
  autosave.schedule()
  mock.timers.tick(500)
  assert.deepEqual(state.saves, [])
  mock.timers.tick(300)
  assert.deepEqual(state.saves, ['új'])
})

test('a flushPending azonnal elmenti a függő szerkesztést, és a késői időzítő már nem ment újra', () => {
  const { state, autosave } = harness()
  state.text = 'új'
  autosave.schedule()
  autosave.flushPending()
  assert.deepEqual(state.saves, ['új'])
  mock.timers.tick(800)
  assert.deepEqual(state.saves, ['új'])
})

test('a flushPending nem ment, ha nincs függő szerkesztés', () => {
  const { state, autosave } = harness()
  state.text = 'új'
  autosave.flushPending()
  assert.deepEqual(state.saves, [])
})

test('nem ment, ha a szöveg megegyezik a legutóbb visszaigazolttal', () => {
  const { state, autosave } = harness()
  autosave.schedule()
  mock.timers.tick(800)
  assert.deepEqual(state.saves, [])
})

test('a cancel ment nélkül dobja el a függő szerkesztést', () => {
  const { state, autosave } = harness()
  state.text = 'új'
  autosave.schedule()
  autosave.cancel()
  mock.timers.tick(800)
  assert.deepEqual(state.saves, [])
})
```

- [ ] **Step 2: Futtasd, hogy lásd bukni**

Run: `cd extensions/docs && node --import tsx --test test/autosave.test.mjs`
Expected: FAIL — a `../ui/autosave.ts` nem található.

- [ ] **Step 3: Implementáld**

`extensions/docs/ui/autosave.ts`:

```ts
/**
 * Debounced saving that can be flushed.
 *
 * The editor used to clear its pending timer on unmount, which threw away the
 * last `delayMs` of typing whenever the reader switched documents or left the
 * page. `flushPending` is the other half: when the editor goes away with an
 * edit still waiting, the edit is saved now instead.
 *
 * `read` and `saved` are asked at the moment of saving, not when the edit was
 * scheduled, so a save that lands in between is taken into account and an
 * unchanged document is never rewritten.
 */

export interface Autosave {
  /** An edit happened: (re)start the countdown. */
  schedule(): void
  /** Save now if an edit is still waiting on the countdown; otherwise do nothing. */
  flushPending(): void
  /** Drop a waiting edit without saving it. */
  cancel(): void
}

export function createAutosave(opts: {
  delayMs: number
  read: () => string
  saved: () => string
  save: (md: string) => void
}): Autosave {
  let timer: ReturnType<typeof setTimeout> | null = null

  const run = () => {
    timer = null
    const md = opts.read()
    if (md !== opts.saved()) opts.save(md)
  }

  return {
    schedule() {
      if (timer) clearTimeout(timer)
      timer = setTimeout(run, opts.delayMs)
    },
    flushPending() {
      if (!timer) return
      clearTimeout(timer)
      run()
    },
    cancel() {
      if (timer) clearTimeout(timer)
      timer = null
    },
  }
}
```

- [ ] **Step 4: Futtasd, hogy lásd átmenni**

Run: `cd extensions/docs && node --import tsx --test test/autosave.test.mjs`
Expected: PASS, 6 teszt.

- [ ] **Step 5: Kösd be a szerkesztőbe**

`extensions/docs/ui/szerkeszto.tsx`:

Importok közé:

```tsx
import { createAutosave, type Autosave } from './autosave'
```

Töröld a sort:

```tsx
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
```

A `ment` `useCallback` UTÁN vedd fel:

```tsx
  // Az autosave a legfrissebb verziót és mentőt olvassa, de nem épül újra
  // tőlük: ha újraépülne, egy mentés visszaigazolása (új `verzio`) eldobná a
  // közben gépelt szöveg időzítőjét. Lebontáskor a ref még az előző doksi
  // értékeit tartja (a React minden cleanupot a következő setupok előtt
  // futtat), így a függő mentés a régi doksiba megy, ahová való.
  const verzioRef = useRef(verzio)
  const mentRef = useRef(ment)
  useEffect(() => {
    verzioRef.current = verzio
    mentRef.current = ment
  })
  // A nyitott doksi autosave-je, hogy a törlés eldobhassa a függő mentést:
  // egy kukába tett doksiba nem írunk utólag új verziót.
  const autosaveRef = useRef<Autosave | null>(null)
  const torolj = useCallback(() => {
    autosaveRef.current?.cancel()
    onTorol()
  }, [onTorol])
```

A törlés gombján (a `onClick={onTorol}` a JSX-ben, jelenleg a 283. sor körül):

```tsx
              onClick={onTorol}
```

helyett:

```tsx
              onClick={torolj}
```

Az „Automatikus mentés” effektet (a `// Automatikus mentés: ...` kommenttől a `}, [editor, id, verzio, ment])`-ig) cseréld erre:

```tsx
  // Automatikus mentés: csak akkor, ha a markdown tényleg más, mint amit a
  // szerver utoljára visszaigazolt. Doksiváltáskor, elnavigáláskor és a lap
  // elhagyásakor (`pagehide`) a függő mentés lefut, nem vész el.
  useEffect(() => {
    if (!editor || !id) return
    const autosave = createAutosave({
      delayMs: AUTOSAVE_MS,
      read: () => htmlToMd(editor.getHTML()),
      saved: () => savedMd.current,
      save: (md) => mentRef.current(md, verzioRef.current),
    })
    autosaveRef.current = autosave
    const onUpdate = () => autosave.schedule()
    const onPageHide = () => autosave.flushPending()
    editor.on('update', onUpdate)
    window.addEventListener('pagehide', onPageHide)
    return () => {
      editor.off('update', onUpdate)
      window.removeEventListener('pagehide', onPageHide)
      autosave.flushPending()
      if (autosaveRef.current === autosave) autosaveRef.current = null
    }
  }, [editor, id])
```

- [ ] **Step 6: Frissítsd a specet**

`doc/specs/2026-09-11-fulek-es-oldalsav-szerkeszto-design.md` — a „**Hibajavítás:**” bekezdést cseréld erre:

```markdown
**Hibajavítás:** a szerkesztő lebontáskor és `pagehide`-kor az időzítő
törlése helyett azonnal ment, ha a markdown eltér a szerver által utoljára
visszaigazolttól. A `pagehide`-kori mentés best-effort: a host `rpc`-je nem
ad `keepalive` opciót, így egy bezáródó oldal a kérést elvághatja. Doksiváltás
és appon belüli navigáció esetén a mentés biztosan kimegy.
```

- [ ] **Step 7: Tesztek, típus, lint**

Run: `cd extensions/docs && npm test`
Expected: minden PASS.

Run: `npx tsc --noEmit && npx eslint extensions/docs/ui/szerkeszto.tsx extensions/docs/ui/autosave.ts` (a repo gyökerében)
Expected: nincs hiba.

- [ ] **Step 8: Commit**

```bash
git add extensions/docs/ui/autosave.ts extensions/docs/test/autosave.test.mjs extensions/docs/ui/szerkeszto.tsx doc/specs/2026-09-11-fulek-es-oldalsav-szerkeszto-design.md
git commit -F - <<'EOF'
Save the Docs editor's pending edit instead of dropping it

The autosave effect cleared its timer on cleanup, so the last 800ms of
typing was lost on switching documents or leaving the page, and a save's
own acknowledgement (a new version) cancelled whatever was typed while it
was in flight. The timer now lives in createAutosave, is rebuilt only per
document, and flushes on cleanup and on pagehide.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_013wE44gRcx8yMbNmXZyGJZL
EOF
```

---

### Task 6: Ellenőrzés az élő appban

**Files:** nincs kódváltozás (ha az ellenőrzés hibát talál, az a hibás task-hoz tartozó javító commit).

- [ ] **Step 1: Teljes teszt- és lint-kör**

Run: `npx tsc --noEmit`
Expected: nincs hiba.

Run: `npx tsx --test src/lib/extensions/page-location.test.ts src/lib/app/palette-extension-pages.test.ts src/lib/extensions/registry.test.ts src/lib/app/nav-sections.test.ts`
Expected: PASS.

Run: `(cd extensions/crm && npm test) && (cd extensions/docs && npm test)`
Expected: PASS.

Run: `npm run lint:baseline`
Expected: nincs új fingerprint. (Ha csökkent: `npm run lint:baseline:update`, és commitold külön „Record the lower lint baseline” üzenettel.)

- [ ] **Step 2: Build és telepítés — KÉRDEZD MEG ELŐTTE A FELHASZNÁLÓT**

Kérdezd meg, melyik példányba telepítsd a bővítményeket (dev szerver a 3456-on vagy az asztali app). Csak jóváhagyás után:

Run: `(cd extensions/crm && npm run build && npm run install:local) && (cd extensions/docs && npm run build && npm run install:local)`
Expected: mindkettő kiírja a célkönyvtárat, hiba nélkül.

- [ ] **Step 3: Élő ellenőrzés böngészőben** (dev-browser vagy nextjs-visual-verification skill)

1. Nyisd meg a `/x/crm` oldalt, kattints egy ügyfélre → az URL `/x/crm/ugyfelek/<id>`, az ablak címe „CRM · <név> · SidekickOS”.
2. Újratöltés → ugyanaz az ügyféllap nyílik.
3. Böngésző vissza → ügyféllista; még egy vissza → Ma.
4. Menj át a `/tasks` oldalra, majd böngésző vissza → az ügyféllista/lap, ahol voltál.
5. `/x/docs`: nyiss meg egy doksit → az URL `/x/docs/doc_…`, a cím „Doksik · <cím> · SidekickOS”; nevezd át → a cím követi.
6. Gépelj a doksiba, és 800 ms-on belül kattints egy másik doksira → vissza az elsőhöz: a beírt szöveg megvan.
7. Gépelj egy doksiba, és 800 ms-on belül töröld (Kukába) → az Archívumban a doksi az utolsó mentett változattal áll, a törlés után nem keletkezett új verzió.
8. ⌘K → gépeld be „CRM” → „Go to CRM” megjelenik, Enterre a `/x/crm` nyílik.

Mindegyik lépésről képernyőkép; a hibás lépés a hozzá tartozó task javítását indítja.

- [ ] **Step 4: Regressziós tesztek rögzítése**

Ha a 3. lépés mind zöld, a viselkedést a Task 1–5 tesztjei már rögzítik. Ha javítás kellett, a javító commit tartalmazza a hibát reprodukáló tesztet is.
