# CRM-3 (Proaktív) — kivitelezési terv

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A CRM megszólal magától: megmondja, mi igényel figyelmet, összefoglalót ír az ügyfelekről, javaslatot tesz, és az elfogadott javaslatból valódi feladat lesz.

**Architecture:** A figyelmet igénylő dolgokat **SQL számolja ki**, nem modell. Az „Ügyfélkezelő" ügynök ezt a listát kapja meg, és abból *ír* — nem abból *következtet*. Az ügynököt deklarált ütemezés kelti, nem heartbeat. Az elfogadott javaslatból a host saját `BoardTask`-ja lesz, a CRM projektben.

**Tech Stack:** Node ESM, `node:test`, `node:sqlite` (teszt), a CRM-1/2-ben lefektetett repo, rpc, tools és MCP-híd rétegek.

**Forrás-spec:** `doc/specs/2026-09-06-crm-extension-design.md` (5., 6. és 9. fejezet)
**Előzmény:** CRM-1 és CRM-2 lezárva, main-re merge-elve (PR #1, #2)

## Global Constraints

- **A kiváltó ok determinisztikus, a fogalmazás LLM.** Ez a fázis vezérelve. Amit a rendszer *eldönt* — mi igényel figyelmet, elavult-e egy összefoglaló — az SQL. A modell csak megfogalmaz.
- **A DB-mezőnevek angolul**, a felület és a kommentek magyarul.
- **A `setup(ctx)` szinkron és idempotens**, csak a `state`-et tölti.
- **Az extension nem importálhat a host `src/`-jéből.**
- **Migrációk csak hozzáadva**: a v1–v5 bájtra érintetlen, új munka új verziószámra.
- **Nevesített hibák**, üres válasz helyett.
- **A lint-baseline kiadási kapu** (345), net-új ujjlenyomat nélkül. `lint:baseline:update` tilos.
- **`git stash` tilos** — a stash-verem megosztott a többi worktree-vel.
- **A dev szervert (3456) és a desktop appot tilos indítani/leállítani.**
- **Commit-üzenetek vége:**
  `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`
  `Claude-Session: https://claude.ai/code/session_01F9MRsWs61Sv7Ub4kEJnWsN`

## Két korrekció a spechez, amit a kód derített ki

**1. Az ügynök nem kaphat heartbeat-et — az ütemezés az egyetlen működő út.**
A spec `heartbeatEnabled: true`-t ír az „Ügyfélkezelő"-höz. Ez **csendben felülíródna**: `src/lib/server/storage-normalization.ts:701` minden betöltéskor `false`-ra állítja CLI-provideres ügynöknél, és a `CLAUDE.md` meg is indokolja — egy CLI-provider előfizetést éget, nem API-kulcsot, és egy flottányi autonóm ébredés nem kapcsolódhat be mellékhatásként. Az `aisignal` mindkét ügynöke `heartbeatEnabled: false`, és **deklarált cron-ütemezés** hajtja őket. Ezt a mintát követjük.

**2. Az MCP-hozzárendelést a deklaráció nem tudja elvégezni.**
`ExtensionManagedAgentDeclaration` ismer `mcpServerIds`-t, de a szerver azonosítója telepítésenként generálódik. Az `aisignal` sem próbálja: a deklarációjában nincs `mcpServerIds`, az operátor rendeli hozzá a Settings → MCP Servers alatt, és a telepítő kiírja a bemásolandó blokkot. **Ebben a telepítésben ez nem opcionális**: minden ügynök `claude-cli`-n fut, tehát az extension `tools` rétegét meg sem kapja — a CRM eszközei kizárólag az MCP-hídon át érik el. A `tools:` mezőt ettől még deklaráljuk (egy API-provideres ügynöknek az az út), de a telepítés-utáni lépés az MCP-hozzárendelés.

---

## File Structure

| Fájl | Felelőssége |
|---|---|
| `extensions/crm/src/attention.mjs` | **tiszta függvény**: a három trigger nyers sorából rangsorolt lista. Nincs benne SQL. |
| `extensions/crm/src/db.mjs` | a három trigger lekérdezései + `listTasksLink` segédek |
| `extensions/crm/src/agents.mjs` | az „Ügyfélkezelő" deklarációja és a rutin — külön fájl, mert a prompt hosszú |
| `extensions/crm/src/tools.mjs` | az író eszközök |
| `extensions/crm/src/rpc.mjs` | `attention`, `acceptSuggestion`, `advanceDeal` |
| `extensions/crm/ui/ma.tsx` | a figyelem-lista és a javaslat elfogadása |
| `extensions/crm/ui/ugyfel-lap.tsx` | a feladatlista |
| `extensions/crm/ui/ugyek.tsx` | szakaszléptetés |

Az `attention.mjs` azért tiszta függvény és azért külön fájl, ugyanazért, amiért a `matching.mjs` az: **a rangsor a rendszer hangja.** Ha rosszul rangsorol, az ügynök a rossz dologról ír, és ez nem hibaüzenetként jelentkezik, hanem úgy, hogy a figyelmeztetések lassan elveszítik a hitelüket. Táblázatosan mérhetőnek kell lennie, adatbázis nélkül.

---

## Task 1: Kimenő levelek behúzása

A spec a „válasz nélküli levél" triggert a CRM-3-hoz sorolja, és a CRM-2 kizárási táblázata kimondja, hogy a kimenő levelek is ide tartoznak: *"a 'válasz nélküli levél' trigger kell hozzá, előbb nincs értelme"*. Enélkül a második trigger nem tud működni — nem tudnánk, válaszoltál-e.

**Files:**
- Modify: `extensions/crm/src/sweep.mjs`, `extensions/crm/index.mjs` (settingsFields)
- Test: `extensions/crm/test/sweep.test.mjs`

**Interfaces:**
- Produces: `event.kind = 'email_out'` sorok; `runSweep` eredménye `recordedOut` mezővel bővül

- [ ] **Step 1: Bukó teszt**

```js
test('a sajat elkuldott level email_out-kent kerul be, nem email_in-kent', async () => {
  const { sweep, repo } = sweepOf([
    LEVEL({ id: 'm_in', labelIds: ['INBOX'], fromEmail: 'dorina@morvai.hu' }),
    LEVEL({ id: 'm_out', labelIds: ['SENT'], threadId: 'thr_1', fromEmail: 'en@sajat.hu' }),
  ])
  const acc = repo.createAccount({ name: 'Morvai Kft.' })
  const con = repo.createContact({ accountId: acc.id, name: 'Dorina' })
  repo.attachEmail(con.id, 'dorina@morvai.hu')

  await sweep.runSweep({})
  const kinds = repo.listEvents({ accountId: acc.id }).map((e) => e.kind).sort()
  assert.deepEqual(kinds, ['email_in', 'email_out'])
})

test('a kimeno level akkor is a szalhoz kerul, ha a felado ismeretlen', async () => {
  const { sweep, repo } = sweepOf([
    LEVEL({ id: 'm_out', labelIds: ['SENT'], threadId: 'thr_x', fromEmail: 'en@sajat.hu' }),
  ])
  const acc = repo.createAccount({ name: 'X' })
  repo.recordEvent({ accountId: acc.id, kind: 'email_in', occurredAt: '2026-09-01T09:00:00.000Z',
                     excerpt: 'e', sourceSystem: 'gmail', sourceId: 'korabbi', threadId: 'thr_x' })
  const r = await sweep.runSweep({})
  assert.equal(r.recordedOut, 1)
  assert.equal(repo.listEvents({ accountId: acc.id })[0].kind, 'email_out')
})
```

- [ ] **Step 2: Futtasd, hogy lásd a bukást**

Run: `cd extensions/crm && node --import tsx --test test/sweep.test.mjs`
Expected: FAIL — a kimenő levél `email_in`-ként vagy sehogy nem jön be.

- [ ] **Step 3: A söprés ismerje fel az irányt**

`src/sweep.mjs`-ben, a `matchMessage` hívása után:

```js
        // A SENT címke az egyetlen megbízható jel arra, hogy ez a levél tőlünk
        // ment. A feladó címére nem építünk: az operátornak több címe lehet, és
        // egy alias vagy egy megosztott postafiók ugyanúgy tőle jön.
        const kimeno = Array.isArray(msg.labelIds) && msg.labelIds.includes('SENT')
        const kind = kimeno ? 'email_out' : 'email_in'
```

és a `recordEvent` hívásában `kind`-ot használj a rögzített `'email_in'` helyett. A visszatérési objektumba vedd fel a `recordedOut` számlálót a `recorded` mellé (a `recorded` a bejövőket számolja, hogy a meglévő tesztek jelentése ne változzon).

**A kimenő levélnél az 1. lépés (pontos cím) szándékosan nem talál** — a feladó te vagy —, tehát a 2. lépés, a szál viszi. Ez helyes: egy kimenő levél oda tartozik, ahova a beszélgetés.

- [ ] **Step 4: A SENT címke elérhetővé tétele**

A CRM-2 `INBOX`-ra szűkítette a listázást. A kimenő levelekhez a `SENT` is kell.

**A meglévő kulcs neve `sopresCimke`** (`index.mjs` `settingsFields`, egyes szám) — ezt ellenőrizd, mielőtt hozzányúlsz. Cseréld egy vesszős listára:

```js
      { key: 'sopresCimkek', label: 'Söprés Gmail-címkéi', type: 'text', defaultValue: 'INBOX,SENT',
        placeholder: 'INBOX,SENT',
        help: 'Vesszővel elválasztva. A SENT nélkül nem látszik, hogy válaszoltál-e — a „válasz nélküli levél” jelzés ettől működik. Tágítani lehet, de minden címke annyi levelet jelent, amennyit tényleg be is húzunk.' },
```

`sweep.mjs` bontsa vesszőnél, vágja a szóközöket, és dobja az üreseket.

**A régi `sopresCimke` kulcsot olvassa be tartalékként.** Az operátor telepítésén ez a mező már be van állítva; ha az új kulcs üres és a régi nem, a régit kell használni. Enélkül egy frissítés némán visszaállítaná az alapértéket, és az operátor beállítása elveszne anélkül, hogy bármi jelezné.

- [ ] **Step 5: Futtasd és commitolj**

Run: `cd extensions/crm && node --import tsx --test test/*.test.mjs`

```bash
git add extensions/crm
git commit -F - <<'MSG'
CRM: kimeno levelek behuzasa

A "valasz nelkuli level" jelzes ettol tud mukodni: eddig nem latszott, hogy
valaszoltal-e. A SENT cimke az egyetlen megbizhato jel arra, hogy a level
tolunk ment -- a felado cimere nem epitunk, mert az operatornak tobb cime
lehet, es egy alias vagy megosztott postafiok ugyanugy tole jon.

A kimeno levelnel a pontos cim szandekosan nem talal (a felado o maga), tehat
a szal viszi. Ez helyes: egy kimeno level oda tartozik, ahova a beszelgetes.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01F9MRsWs61Sv7Ub4kEJnWsN
MSG
```

---

## Task 2: A három trigger — a lekérdezések

**Files:**
- Modify: `extensions/crm/src/db.mjs`
- Test: `extensions/crm/test/db.test.mjs`

**Interfaces:**
- Produces:
  `silentDeals(cutoffIso) → [{ deal_id, account_id, title, last_event_at }]`
  `unansweredThreads(cutoffIso) → [{ account_id, thread_id, event_id, subject, occurred_at }]`
  `openCommitmentsOlderThan(cutoffIso, direction) → [{ id, account_id, event_id, text, direction, created_at }]`

- [ ] **Step 1: Bukó tesztek**

```js
test('silentDeals csak a NYITOTT ugyeket adja, es csak a nemakat', () => {
  const { repo } = repoOf()
  const acc = repo.createAccount({ name: 'X' })
  const nema = repo.createDeal({ accountId: acc.id, title: 'Nema' })
  const friss = repo.createDeal({ accountId: acc.id, title: 'Friss' })
  const zart = repo.createDeal({ accountId: acc.id, title: 'Zart' })
  repo.closeDeal(zart.id, { stage: 'won', reason: '' })

  repo.recordEvent({ accountId: acc.id, dealId: nema.id, kind: 'note',
    occurredAt: '2026-08-01T10:00:00.000Z', excerpt: 'regi', sourceSystem: 'manual', sourceId: 'r1' })
  repo.recordEvent({ accountId: acc.id, dealId: friss.id, kind: 'note',
    occurredAt: '2026-09-05T10:00:00.000Z', excerpt: 'uj', sourceSystem: 'manual', sourceId: 'r2' })
  repo.recordEvent({ accountId: acc.id, dealId: zart.id, kind: 'note',
    occurredAt: '2026-08-01T10:00:00.000Z', excerpt: 'regi', sourceSystem: 'manual', sourceId: 'r3' })

  const nemak = repo.silentDeals('2026-09-01T00:00:00.000Z')
  assert.deepEqual(nemak.map((d) => d.title), ['Nema'])
})

test('silentDeals az esemeny nelkuli nyitott ugyet is nemanak szamolja', () => {
  const { repo } = repoOf()
  const acc = repo.createAccount({ name: 'X' })
  repo.createDeal({ accountId: acc.id, title: 'Sosem tortent semmi' })
  const nemak = repo.silentDeals('2026-09-01T00:00:00.000Z')
  assert.equal(nemak.length, 1, 'egy ugy, amin SOHA nem tortent semmi, a legnemabb')
  assert.equal(nemak[0].last_event_at, null)
})

test('unansweredThreads csak azt adja, amire nem ment valasz', () => {
  const { repo } = repoOf()
  const acc = repo.createAccount({ name: 'X' })
  repo.recordEvent({ accountId: acc.id, kind: 'email_in', occurredAt: '2026-08-20T10:00:00.000Z',
    title: 'Varok valaszt', excerpt: 'e', sourceSystem: 'gmail', sourceId: 'a1', threadId: 'thr_a' })
  repo.recordEvent({ accountId: acc.id, kind: 'email_in', occurredAt: '2026-08-20T10:00:00.000Z',
    title: 'Ez megvalaszolva', excerpt: 'e', sourceSystem: 'gmail', sourceId: 'b1', threadId: 'thr_b' })
  repo.recordEvent({ accountId: acc.id, kind: 'email_out', occurredAt: '2026-08-21T10:00:00.000Z',
    excerpt: 'valasz', sourceSystem: 'gmail', sourceId: 'b2', threadId: 'thr_b' })

  const varok = repo.unansweredThreads('2026-09-01T00:00:00.000Z')
  assert.deepEqual(varok.map((x) => x.thread_id), ['thr_a'])
})

test('unansweredThreads a KESOBBI valaszt szamitja, nem barmelyiket', () => {
  const { repo } = repoOf()
  const acc = repo.createAccount({ name: 'X' })
  repo.recordEvent({ accountId: acc.id, kind: 'email_out', occurredAt: '2026-08-10T10:00:00.000Z',
    excerpt: 'regi valasz', sourceSystem: 'gmail', sourceId: 'o1', threadId: 'thr_c' })
  repo.recordEvent({ accountId: acc.id, kind: 'email_in', occurredAt: '2026-08-20T10:00:00.000Z',
    title: 'Ujabb kerdes', excerpt: 'e', sourceSystem: 'gmail', sourceId: 'i1', threadId: 'thr_c' })

  const varok = repo.unansweredThreads('2026-09-01T00:00:00.000Z')
  assert.deepEqual(varok.map((x) => x.thread_id), ['thr_c'],
    'a valasz KORABBI mint a kerdes, tehat nem valasz ra')
})

test('openCommitmentsOlderThan iranyra szur es a feladat nelkulieket adja', () => {
  const { repo } = repoOf()
  const acc = repo.createAccount({ name: 'X' })
  const { event } = repo.recordEvent({ accountId: acc.id, kind: 'meeting',
    occurredAt: '2026-08-01T10:00:00.000Z', excerpt: 'x', sourceSystem: 'manual', sourceId: 'm1' })
  const enyem = repo.writeCommitment({ accountId: acc.id, eventId: event.id, text: 'Kuldom', direction: 'ours' })
  repo.writeCommitment({ accountId: acc.id, eventId: event.id, text: 'Kuldi', direction: 'theirs' })
  const mar = repo.writeCommitment({ accountId: acc.id, eventId: event.id, text: 'Ez kesz', direction: 'ours' })
  repo.linkCommitmentTask(mar.id, 'task_1')

  const sajat = repo.openCommitmentsOlderThan('2026-09-01T00:00:00.000Z', 'ours')
  assert.deepEqual(sajat.map((c) => c.id), [enyem.id])
})
```

- [ ] **Step 2: Futtasd, hogy lásd a bukást**

Run: `cd extensions/crm && node --import tsx --test test/db.test.mjs`
Expected: FAIL — `repo.silentDeals is not a function`

- [ ] **Step 3: Írd meg a három lekérdezést**

A `createRepo` visszatérési objektumába, a `setSweepState` után:

```js
    // ---- figyelem-triggerek ----
    /**
     * Nyitott ügyek, amiken a küszöb óta nem történt semmi.
     *
     * A `LEFT JOIN` szándékos: egy ügy, amin SOHA nem történt semmi, a
     * legnémább, és egy `INNER JOIN` pont azt hagyná ki. A `HAVING` a
     * `NULL`-t is átengedi, mert a `MAX()` üres halmazon `NULL`.
     */
    silentDeals(cutoffIso) {
      return S.all(
        `SELECT d.id AS deal_id, d.account_id, d.title, MAX(e.occurred_at) AS last_event_at
         FROM ext_crm_deal d
         LEFT JOIN ext_crm_event e ON e.deal_id = d.id
         WHERE d.closed_at IS NULL
         GROUP BY d.id
         HAVING last_event_at IS NULL OR last_event_at < ?
         ORDER BY last_event_at ASC`,
        [cutoffIso],
      )
    },

    /**
     * Bejövő levelek, amikre a szálban NEM ment későbbi válasz.
     *
     * A „későbbi" a lényeg: egy hónapja küldött válasz nem válasz a tegnapi
     * kérdésre. A NOT EXISTS ezért hasonlítja az időpontokat, nem csak azt
     * nézi, van-e egyáltalán kimenő levél a szálban.
     */
    unansweredThreads(cutoffIso) {
      return S.all(
        `SELECT e.account_id, e.thread_id, e.id AS event_id, e.title AS subject, e.occurred_at
         FROM ext_crm_event e
         WHERE e.kind = 'email_in'
           AND e.thread_id <> ''
           AND e.occurred_at < ?
           AND NOT EXISTS (
             SELECT 1 FROM ext_crm_event v
             WHERE v.thread_id = e.thread_id
               AND v.kind = 'email_out'
               AND v.occurred_at > e.occurred_at
           )
         ORDER BY e.occurred_at ASC`,
        [cutoffIso],
      )
    },

    /**
     * Nyitott, feladat nélküli ígéretek egy irányból, a küszöbnél régebbiek.
     *
     * Az irány nem díszítés: amit én ígértem, az az én tartozásom, amit nekem
     * ígértek, az az ő tartozásuk — más a sürgősségük és más a teendő.
     */
    openCommitmentsOlderThan(cutoffIso, direction) {
      return S.all(
        `SELECT id, account_id, deal_id, event_id, text, direction, created_at
         FROM ext_crm_commitment
         WHERE status = 'open' AND task_id IS NULL AND direction = ? AND created_at < ?
         ORDER BY created_at ASC`,
        [direction, cutoffIso],
      )
    },
```

- [ ] **Step 4: Futtasd és commitolj**

Run: `cd extensions/crm && node --import tsx --test test/*.test.mjs`

```bash
git add extensions/crm/src/db.mjs extensions/crm/test/db.test.mjs
git commit -F - <<'MSG'
CRM: a harom figyelem-trigger lekerdezese

Mindharom SQL, egyetlen modellhivas nelkul. Ez a fazis vezerelve: a kivalto
ok determinisztikus, a fogalmazas az LLM-e.

A silentDeals LEFT JOIN-t hasznal, mert egy ugy, amin SOHA nem tortent semmi,
a legnemabb -- egy INNER JOIN pont azt hagyna ki.

Az unansweredThreads a KESOBBI valaszt nezi, nem barmelyiket: egy honapja
kuldott valasz nem valasz a tegnapi kerdesre.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01F9MRsWs61Sv7Ub4kEJnWsN
MSG
```

---

## Task 3: A rangsor — tiszta függvény

**Files:**
- Create: `extensions/crm/src/attention.mjs`
- Test: `extensions/crm/test/attention.test.mjs`

**Interfaces:**
- Produces: `rangsor({ silent, unanswered, oursOverdue, theirsOverdue }, most) → [{ kind, accountId, dealId?, commitmentId?, eventId?, cim, indok, kor }]`
  ahol `kind ∈ 'nema_ugy' | 'valasz_nelkul' | 'sajat_igeret' | 'idegen_igeret'`, `kor` a napokban mért elhanyagoltság

**Miért tiszta függvény:** a rangsor a rendszer hangja. Ha rosszul sorrendez, az ügynök a rossz dologról ír — és ez nem hibaüzenetként jelentkezik, hanem úgy, hogy a figyelmeztetések néhány hét alatt elveszítik a hitelüket. Táblázatosan mérhetőnek kell lennie, adatbázis nélkül.

- [ ] **Step 1: Bukó teszt**

```js
import assert from 'node:assert/strict'
import test from 'node:test'

import { rangsor } from '../src/attention.mjs'

const MOST = '2026-09-06T12:00:00.000Z'

test('ures bemenetre ures lista', () => {
  assert.deepEqual(rangsor({ silent: [], unanswered: [], oursOverdue: [], theirsOverdue: [] }, MOST), [])
})

test('a sajat igeret elozi a tobbit azonos kornal', () => {
  const nap = (n) => new Date(Date.parse(MOST) - n * 86400000).toISOString()
  const lista = rangsor({
    silent: [{ deal_id: 'd1', account_id: 'a1', title: 'Ugy', last_event_at: nap(10) }],
    unanswered: [{ account_id: 'a1', thread_id: 't1', event_id: 'e1', subject: 'Level', occurred_at: nap(10) }],
    oursOverdue: [{ id: 'c1', account_id: 'a1', event_id: 'e2', text: 'Kuldom', direction: 'ours', created_at: nap(10) }],
    theirsOverdue: [{ id: 'c2', account_id: 'a1', event_id: 'e3', text: 'Kuldi', direction: 'theirs', created_at: nap(10) }],
  }, MOST)
  assert.equal(lista[0].kind, 'sajat_igeret', 'amit EN igertem, az az en tartozasom')
})

test('azonos tipuson belul a regebbi elorebb', () => {
  const nap = (n) => new Date(Date.parse(MOST) - n * 86400000).toISOString()
  const lista = rangsor({
    silent: [
      { deal_id: 'uj', account_id: 'a1', title: 'Ujabb', last_event_at: nap(10) },
      { deal_id: 'regi', account_id: 'a1', title: 'Regebbi', last_event_at: nap(40) },
    ],
    unanswered: [], oursOverdue: [], theirsOverdue: [],
  }, MOST)
  assert.deepEqual(lista.map((x) => x.dealId), ['regi', 'uj'])
})

test('az esemeny nelkuli ugy kora nem NaN, es a lista elejere kerul', () => {
  const lista = rangsor({
    silent: [
      { deal_id: 'sosem', account_id: 'a1', title: 'Sosem', last_event_at: null },
      { deal_id: 'volt', account_id: 'a1', title: 'Volt',
        last_event_at: new Date(Date.parse(MOST) - 5 * 86400000).toISOString() },
    ],
    unanswered: [], oursOverdue: [], theirsOverdue: [],
  }, MOST)
  assert.equal(Number.isFinite(lista[0].kor), true)
  assert.equal(lista[0].dealId, 'sosem')
})

test('minden sor megmondja, MIERT van rajta', () => {
  const nap = (n) => new Date(Date.parse(MOST) - n * 86400000).toISOString()
  const lista = rangsor({
    silent: [], unanswered: [{ account_id: 'a1', thread_id: 't1', event_id: 'e1', subject: 'Ajanlat?', occurred_at: nap(4) }],
    oursOverdue: [], theirsOverdue: [],
  }, MOST)
  assert.match(lista[0].indok, /4 napja/)
  assert.match(lista[0].cim, /Ajanlat\?/)
})
```

- [ ] **Step 2: Futtasd, hogy lásd a bukást**

Run: `cd extensions/crm && node --test test/attention.test.mjs`
Expected: FAIL — `Cannot find module '../src/attention.mjs'`

- [ ] **Step 3: Írd meg a modult**

`extensions/crm/src/attention.mjs`:

```js
/**
 * Mi igényel figyelmet, és milyen sorrendben.
 *
 * TISZTA FÜGGVÉNY, ADATBÁZIS NÉLKÜL. A rangsor a rendszer hangja: ha rosszul
 * sorrendez, az ügynök a rossz dologról ír, és ez nem hibaüzenetként
 * jelentkezik — hanem úgy, hogy a figyelmeztetések néhány hét alatt
 * elveszítik a hitelüket. Egy táblázatos teszt ezt olcsón megfogja; egy
 * adatbázisra kötött nem.
 *
 * ITT SINCS MODELLHÍVÁS. A rangsor számolt: a típus adja a súlyt, a kor a
 * finomhangolást. Az ügynök ebből ÍR, nem ebből KÖVETKEZTET.
 */

/**
 * A négy típus súlya, romló sürgősség szerint.
 *
 * A saját ígéret vezet, mert az az egyetlen, ami a te szavadon múlik: a másik
 * három azt írja le, hogy valami nem történt meg, ez azt, hogy te mondtad,
 * hogy meg fog. Az idegen ígéret zár, mert azon nem te dolgozol — csak tudni
 * kell róla, mielőtt elévül.
 */
const SULY = Object.freeze({
  sajat_igeret: 0,
  valasz_nelkul: 1,
  nema_ugy: 2,
  idegen_igeret: 3,
})

/** Hány napja. Hiányzó időpont a végtelen múlt: az sosem történt meg. */
function korNapban(iso, most) {
  if (!iso) return Number.MAX_SAFE_INTEGER
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return Number.MAX_SAFE_INTEGER
  return Math.floor((Date.parse(most) - t) / 86400000)
}

const napSzoveg = (k) => (k === Number.MAX_SAFE_INTEGER ? 'még soha' : `${k} napja`)

export function rangsor({ silent = [], unanswered = [], oursOverdue = [], theirsOverdue = [] }, most) {
  const sorok = []

  for (const d of silent) {
    const kor = korNapban(d.last_event_at, most)
    sorok.push({
      kind: 'nema_ugy', accountId: d.account_id, dealId: d.deal_id, kor,
      cim: d.title,
      indok: d.last_event_at ? `${napSzoveg(kor)} nem történt semmi ezen a nyitott ügyön` : 'ezen a nyitott ügyön még soha nem történt semmi',
    })
  }

  for (const u of unanswered) {
    const kor = korNapban(u.occurred_at, most)
    sorok.push({
      kind: 'valasz_nelkul', accountId: u.account_id, eventId: u.event_id, kor,
      cim: u.subject || '(tárgy nélkül)',
      indok: `${napSzoveg(kor)} érkezett, és nem ment rá válasz`,
    })
  }

  for (const c of oursOverdue) {
    const kor = korNapban(c.created_at, most)
    sorok.push({
      kind: 'sajat_igeret', accountId: c.account_id, dealId: c.deal_id || null,
      commitmentId: c.id, eventId: c.event_id, kor,
      cim: c.text,
      indok: `${napSzoveg(kor)} ígérted, és nem lett belőle feladat`,
    })
  }

  for (const c of theirsOverdue) {
    const kor = korNapban(c.created_at, most)
    sorok.push({
      kind: 'idegen_igeret', accountId: c.account_id, dealId: c.deal_id || null,
      commitmentId: c.id, eventId: c.event_id, kor,
      cim: c.text,
      indok: `${napSzoveg(kor)} ígérték neked, és nem érkezett meg`,
    })
  }

  // Típus előbb, kor utána. Az `id` a döntetlent töri, hogy a sorrend két
  // egyforma futás közt ne mozogjon -- egy ingadozó lista olvashatatlan.
  return sorok.sort((a, b) =>
    SULY[a.kind] - SULY[b.kind]
    || b.kor - a.kor
    || String(a.commitmentId || a.dealId || a.eventId).localeCompare(String(b.commitmentId || b.dealId || b.eventId)))
}
```

- [ ] **Step 4: Futtasd és commitolj**

Run: `cd extensions/crm && node --test test/attention.test.mjs`

```bash
git add extensions/crm/src/attention.mjs extensions/crm/test/attention.test.mjs
git commit -F - <<'MSG'
CRM: a figyelem-rangsor, tiszta fuggvenykent

A rangsor a rendszer hangja. Ha rosszul sorrendez, az ugynok a rossz dologrol
ir, es ez nem hibauzenetkent jelentkezik -- hanem ugy, hogy a figyelmeztetesek
nehany het alatt elveszitik a hiteluket. Adatbazis nelkul tablazatosan merheto.

A sajat igeret vezet: a masik harom azt irja le, hogy valami nem tortent meg,
ez azt, hogy TE mondtad, hogy meg fog. Az idegen igeret zar, mert azon nem te
dolgozol -- csak tudni kell rola, mielott elevul.

A dontetlent azonosito tori, hogy a sorrend ket egyforma futas kozt ne
mozogjon: egy ingadozo lista olvashatatlan.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01F9MRsWs61Sv7Ub4kEJnWsN
MSG
```

---

## Task 4: `crm_attention` — a lista az ügynöknek és a lapnak

**Files:**
- Modify: `extensions/crm/src/rpc.mjs`, `extensions/crm/src/tools.mjs`
- Test: `extensions/crm/test/rpc.test.mjs`, `extensions/crm/test/tools.test.mjs`

**Interfaces:**
- Consumes: `rangsor` (Task 3), a három lekérdezés (Task 2), a CRM-1 küszöb-beállításai
- Produces: `createAttention(state) → { list({ limit }) → { sorok, kuszobok } }`; rpc `attention`; tool `crm_attention`

- [ ] **Step 1: Bukó tesztek**

`test/rpc.test.mjs`-hez:

```js
test('az attention a beallitott kuszoboket hasznalja, nem beegetett szamokat', async () => {
  const S = memStorage()
  for (const m of MIGRATIONS) S.raw.exec(m.sql)
  const repo = createRepo(S)
  const state = { storage: S, repo, log: console, settings: () => ({ nemaNapok: 1 }) }
  const rpc = createRpc(state)

  const acc = repo.createAccount({ name: 'X' })
  const deal = repo.createDeal({ accountId: acc.id, title: 'Nema ugy' })
  repo.recordEvent({ accountId: acc.id, dealId: deal.id, kind: 'note',
    occurredAt: new Date(Date.now() - 3 * 86400000).toISOString(),
    excerpt: 'e', sourceSystem: 'manual', sourceId: 'n1' })

  const r = await rpc.attention({})
  assert.equal(r.kuszobok.nemaNapok, 1)
  assert.ok(r.sorok.some((s) => s.kind === 'nema_ugy' && s.dealId === deal.id))
})

test('az attention az alapertekekre esik vissza, ha a beallitas ures', async () => {
  const { rpc } = rpcOf()          // rpcOf settings-e ures objektumot ad
  const r = await rpc.attention({})
  assert.deepEqual(r.kuszobok, { nemaNapok: 9, valaszNapok: 3, igeretNapok: 2, idegenIgeretNapok: 7 })
})
```

`test/tools.test.mjs`-hez:

```js
test('a CRM-3 utan hat eszkoz van, es a crm_attention koztuk', () => {
  const { list } = toolsOf()
  assert.ok(list.map((t) => t.name).includes('crm_attention'))
})
```

- [ ] **Step 2: Futtasd, hogy lásd a bukást**

Run: `cd extensions/crm && node --import tsx --test test/rpc.test.mjs test/tools.test.mjs`
Expected: FAIL — `rpc.attention is not a function`

- [ ] **Step 3: Írd meg a réteget**

Új fájl `extensions/crm/src/attention-service.mjs` — az `attention.mjs` marad tiszta, ez köti a repóhoz:

```js
import { rangsor } from './attention.mjs'

/** A négy küszöb alapértéke. A CRM-1 settingsFields-e ugyanezeket hirdeti. */
export const ALAP_KUSZOBOK = Object.freeze({
  nemaNapok: 9, valaszNapok: 3, igeretNapok: 2, idegenIgeretNapok: 7,
})

/**
 * A beállított küszöbök, alapértékkel kitöltve.
 *
 * Egy kiürített mező NEM nulla: az operátor törölte, nem azt kérte, hogy
 * mindenre azonnal szóljunk. A `Number` üres stringre `0`-t ad, ezért kell a
 * kifejezett `Number.isFinite` és a pozitivitás-ellenőrzés.
 */
export function kuszobokOf(settings) {
  const s = settings ? settings() : {}
  const olvas = (kulcs) => {
    const n = Number(s[kulcs])
    return Number.isFinite(n) && n > 0 ? n : ALAP_KUSZOBOK[kulcs]
  }
  return {
    nemaNapok: olvas('nemaNapok'),
    valaszNapok: olvas('valaszNapok'),
    igeretNapok: olvas('igeretNapok'),
    idegenIgeretNapok: olvas('idegenIgeretNapok'),
  }
}

const kivon = (most, napok) => new Date(Date.parse(most) - napok * 86400000).toISOString()

export function createAttention(state) {
  const repo = () => {
    if (!state.repo) throw new Error('crm_nincs_tar')
    return state.repo
  }

  return {
    /**
     * A rangsorolt figyelem-lista. Négy lekérdezés és egy rendezés — egyetlen
     * modellhívás nélkül.
     */
    list({ limit = 50, most = new Date().toISOString() } = {}) {
      const r = repo()
      const k = kuszobokOf(state.settings)
      const sorok = rangsor({
        silent: r.silentDeals(kivon(most, k.nemaNapok)),
        unanswered: r.unansweredThreads(kivon(most, k.valaszNapok)),
        oursOverdue: r.openCommitmentsOlderThan(kivon(most, k.igeretNapok), 'ours'),
        theirsOverdue: r.openCommitmentsOlderThan(kivon(most, k.idegenIgeretNapok), 'theirs'),
      }, most)
      return { sorok: sorok.slice(0, limit), kuszobok: k, osszes: sorok.length }
    },
  }
}
```

`src/rpc.mjs`-be:

```js
    /** A figyelem-lista a lapnak. */
    async attention({ limit } = {}) {
      return createAttention(state).list({ limit: Number(limit) || 50 })
    },
```

`src/tools.mjs`-be:

```js
    {
      name: 'crm_attention',
      description: 'Mi igényel figyelmet, rangsorolva: néma nyitott ügyek, válasz nélküli levelek, és feladat nélküli ígéretek mindkét irányba. A sorrend és az ok determinisztikus — ne számold újra, és ne találj ki mást; ebből ÍRJ, ne ebből következtess.',
      parameters: {
        type: 'object',
        properties: { limit: { type: 'number', description: 'Legfeljebb ennyi sort adj vissza.' } },
      },
      async execute({ limit }) {
        return createAttention(state).list({ limit: Number(limit) || 50 })
      },
    },
```

- [ ] **Step 4: Futtasd és commitolj**

Run: `cd extensions/crm && node --import tsx --test test/*.test.mjs`

```bash
git add extensions/crm
git commit -F - <<'MSG'
CRM: crm_attention -- a figyelem-lista

Negy lekerdezes es egy rendezes, egyetlen modellhivas nelkul. Az eszkoz
leirasa kimondja az ugynoknek, hogy ebbol IRJON, ne ebbol kovetkeztessen.

Egy kiuritett kuszob-mezo nem nulla: az operator torolte, nem azt kerte, hogy
mindenre azonnal szoljunk. A Number ures stringre 0-t ad, ezert kell a
kifejezett ellenorzes.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01F9MRsWs61Sv7Ub4kEJnWsN
MSG
```

---

## Task 5: Az író eszközök

**Files:**
- Modify: `extensions/crm/src/tools.mjs`
- Test: `extensions/crm/test/tools.test.mjs`

**Interfaces:**
- Produces: `crm_note`, `crm_summary_write`, `crm_commitment_write`, `crm_commitment_link`, `crm_suggestion_write`

**A határ, amit ez a feladat nem léphet át.** A CRM-1 óta áll: az ügynök **nem** hozhat létre és nem törölhet ügyfelet, kapcsolatot vagy ügyet, nem állíthat `deal.stage`-et vagy `account.status`-t, nem rendelhet hozzá besorolatlan levelet, és **nem fogadhatja el a saját javaslatát**. A tiltott-nevek teszt ezt őrzi — bővítsd, ne gyengítsd.

- [ ] **Step 1: Bukó tesztek**

```js
test('a covers_event_id-t a SZERVER belyegzi, az ugynok nem adhatja meg', async () => {
  const { byName, repo } = toolsOf()
  const acc = repo.createAccount({ name: 'X' })
  repo.recordEvent({ accountId: acc.id, kind: 'note', occurredAt: '2026-09-01T10:00:00.000Z',
    excerpt: 'e1', sourceSystem: 'manual', sourceId: 'n1' })

  // Az ugynok megprobalja allitani, hogy tobbet fedett le:
  await byName.crm_summary_write.execute(
    { accountId: acc.id, text: 'osszefoglalo', coversEventId: 'evt_hazugsag', covers_event_id: 'evt_hazugsag' },
    { session: { agentId: 'ag1' } })

  const s = repo.latestSummary(acc.id)
  assert.notEqual(s.summary.covers_event_id, 'evt_hazugsag')
  assert.equal(s.summary.covers_event_at, '2026-09-01T10:00:00.000Z')
})

test('az osszefoglalo rogziti, MELYIK ugynok irta', async () => {
  const { byName, repo } = toolsOf()
  const acc = repo.createAccount({ name: 'X' })
  await byName.crm_summary_write.execute({ accountId: acc.id, text: 'x' }, { session: { agentId: 'ugyfelkezelo' } })
  assert.equal(repo.latestSummary(acc.id).summary.generated_by_agent_id, 'ugyfelkezelo')
})

test('az ugynok tovabbra sem lephet at a kapun', () => {
  const { byName } = toolsOf()
  for (const tiltott of ['crm_create_account', 'crm_close_deal', 'crm_assign_unmatched',
                         'crm_attach_email', 'crm_create_deal', 'crm_accept_suggestion',
                         'crm_advance_deal']) {
    assert.equal(byName[tiltott], undefined, `${tiltott} nem lehet az ugynok kezeben`)
  }
})
```

- [ ] **Step 2: Futtasd, hogy lásd a bukást**

Run: `cd extensions/crm && node --import tsx --test test/tools.test.mjs`
Expected: FAIL — `Cannot read properties of undefined (reading 'execute')`

- [ ] **Step 3: Írd meg az öt eszközt**

`src/tools.mjs`-be. **Egyik `execute` sem továbbítja az `args`-ot szórással a repo felé** — minden mezőt nevesítve olvasunk ki, különben egy `coversEventId` átcsúszna:

```js
    {
      name: 'crm_note',
      description: 'Jegyzet az ügyfél idővonalára. Arra való, hogy rögzítsd, amit megtudtál — nem arra, hogy összefoglalj.',
      parameters: {
        type: 'object',
        properties: { accountId: { type: 'string' }, text: { type: 'string' } },
        required: ['accountId', 'text'],
      },
      async execute({ accountId, text }, ctx) {
        const r = repo()
        if (!r.getAccount(accountId)) throw new Error('crm_ismeretlen_ugyfel')
        const at = new Date().toISOString()
        return r.recordEvent({
          accountId, kind: 'note', occurredAt: at,
          excerpt: String(text || '').slice(0, 200),
          sourceSystem: 'agent',
          sourceId: `agent:${ctx?.session?.agentId || 'ismeretlen'}:${at}`,
          body: String(text || ''),
        })
      },
    },
    {
      name: 'crm_summary_write',
      description: 'Összefoglaló az ügyfélről. Azt írd le, ami az idővonalon tényleg szerepel. A lefedettséget a rendszer bélyegzi rá — nem tudod és nem is kell megadnod.',
      parameters: {
        type: 'object',
        properties: { accountId: { type: 'string' }, text: { type: 'string' } },
        required: ['accountId', 'text'],
      },
      async execute({ accountId, text }, ctx) {
        const r = repo()
        if (!r.getAccount(accountId)) throw new Error('crm_ismeretlen_ugyfel')
        return r.writeSummary({ accountId, text: String(text || ''), agentId: ctx?.session?.agentId || '' })
      },
    },
    {
      name: 'crm_commitment_write',
      description: 'Egy elhangzott ígéret rögzítése egy eseményből. A direction az ígérő oldala: "ours" amit az operátor ígért, "theirs" amit neki ígértek.',
      parameters: {
        type: 'object',
        properties: {
          accountId: { type: 'string' }, eventId: { type: 'string' }, text: { type: 'string' },
          direction: { type: 'string', enum: ['ours', 'theirs'] },
          dueHint: { type: 'string', description: 'Ha elhangzott határidő, szó szerint.' },
        },
        required: ['accountId', 'eventId', 'text', 'direction'],
      },
      async execute({ accountId, eventId, text, direction, dueHint }) {
        const r = repo()
        if (!r.getAccount(accountId)) throw new Error('crm_ismeretlen_ugyfel')
        if (!r.getEvent(eventId)) throw new Error('crm_ismeretlen_esemeny')
        if (direction !== 'ours' && direction !== 'theirs') throw new Error('crm_ismeretlen_igeret_irany')
        return r.writeCommitment({ accountId, eventId, text: String(text || ''), direction, dueHint: String(dueHint || '') })
      },
    },
    {
      name: 'crm_commitment_link',
      description: 'Egy ígéret összekötése a belőle született feladattal. Ezután az ígéret nem szerepel többé a figyelem-listán.',
      parameters: {
        type: 'object',
        properties: { commitmentId: { type: 'string' }, taskId: { type: 'string' } },
        required: ['commitmentId', 'taskId'],
      },
      async execute({ commitmentId, taskId }) {
        const out = repo().linkCommitmentTask(commitmentId, String(taskId || ''))
        if (!out) throw new Error('crm_ismeretlen_igeret')
        return out
      },
    },
    {
      name: 'crm_suggestion_write',
      description: 'Javaslat az operátornak egy következő lépésre. Te javasolsz, ő dönt — elfogadni nem tudod, és az elfogadás az, ami feladatot csinál belőle.',
      parameters: {
        type: 'object',
        properties: {
          accountId: { type: 'string' }, text: { type: 'string' },
          reason: { type: 'string', description: 'Egy mondat arról, mire alapozod.' },
          triggerKind: { type: 'string', description: 'A crm_attention sorának kind mezője, ha abból jött.' },
          triggerEventId: { type: 'string' },
        },
        required: ['accountId', 'text'],
      },
      async execute({ accountId, text, reason, triggerKind, triggerEventId }, ctx) {
        const r = repo()
        if (!r.getAccount(accountId)) throw new Error('crm_ismeretlen_ugyfel')
        return r.writeSuggestion({
          accountId, text: String(text || ''), reason: String(reason || ''),
          triggerKind: String(triggerKind || ''), triggerEventId: triggerEventId || null,
          agentId: ctx?.session?.agentId || '',
        })
      },
    },
```

- [ ] **Step 4: Futtasd és commitolj**

Run: `cd extensions/crm && node --import tsx --test test/*.test.mjs`

```bash
git add extensions/crm
git commit -F - <<'MSG'
CRM: az ugynok iro eszkozei

Ot eszkoz: jegyzet, osszefoglalo, igeret, igeret-feladat kotes, javaslat.

A covers_event_id-t tovabbra is a szerver belyegzi. Egyik execute sem
tovabbitja az args-ot szorassal a repo fele -- minden mezot nevesitve
olvasunk ki, kulonben egy coversEventId atcsuszna, es az ugynok allithatna,
hogy tobbet olvasott, mint amennyit. Egy teszt pontosan ezt probalja meg.

A kapu erintetlen: a tiltott-nevek teszt bovult, nem gyengult. Az ugynok tovabbra
sem fogadhatja el a sajat javaslatat -- az elfogadas az, ami feladatot csinal belole.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01F9MRsWs61Sv7Ub4kEJnWsN
MSG
```

---

## Task 6: Az „Ügyfélkezelő" ügynök és a rutin

**Files:**
- Create: `extensions/crm/src/agents.mjs`
- Modify: `extensions/crm/index.mjs`, `extensions/crm/scripts/install.mjs`
- Test: `extensions/crm/test/agents.test.mjs`

**Interfaces:**
- Produces: `AGENTS` és `SCHEDULES` fagyasztott tömbök, a host `ExtensionManagedAgentDeclaration` / `ExtensionManagedScheduleDeclaration` alakjában

**Olvasd el előbb** az `extensions/aisignal/src/agents.mjs` végét (`AGENTS` és `SCHEDULES`) — ez a bevett minta, és a mezőnevek onnan igazolhatók.

- [ ] **Step 1: Bukó teszt**

```js
import assert from 'node:assert/strict'
import test from 'node:test'

import crm from '../index.mjs'
import { AGENTS, SCHEDULES } from '../src/agents.mjs'

test('egy ugynok van deklaralva, es a manifest ot viszi', () => {
  assert.equal(AGENTS.length, 1)
  assert.equal(AGENTS[0].agentKey, 'crm-ugyfelkezelo')
  assert.deepEqual(crm.managedResources.agents, AGENTS)
})

test('a heartbeat KI van kapcsolva -- az utemezes hajtja', () => {
  assert.equal(AGENTS[0].heartbeatEnabled, false,
    'CLI-provideren a host minden betolteskor false-ra allitana; az utemezes az egyetlen mukodo ut')
})

test('a deklaracio NEM nevez meg mcpServerIds-t', () => {
  assert.equal('mcpServerIds' in AGENTS[0], false,
    'a szerver azonositoja telepitesenkent mas; az operator rendeli hozza')
})

test('a rutin az ugynokre hivatkozik es napi cronon fut', () => {
  assert.equal(SCHEDULES.length, 1)
  const s = SCHEDULES[0]
  assert.equal(s.agentRef.resourceKey, 'crm-ugyfelkezelo')
  assert.equal(s.scheduleType, 'cron')
  assert.match(s.cron, /^\d+ \d+ \* \* \*$/)
  assert.equal(s.timezone, 'Europe/Budapest')
})

test('a rutin promptja a crm_attention-t nevezi meg kiindulasnak', () => {
  assert.match(SCHEDULES[0].taskPrompt, /crm_attention/)
})

test('az ugynok promptja megtiltja a talalgatast', () => {
  assert.match(AGENTS[0].systemPrompt, /crm_attention/)
  assert.match(AGENTS[0].systemPrompt, /ne (talalgass|találgass)/i)
})
```

- [ ] **Step 2: Futtasd, hogy lásd a bukást**

Run: `cd extensions/crm && node --import tsx --test test/agents.test.mjs`
Expected: FAIL — `Cannot find module '../src/agents.mjs'`

- [ ] **Step 3: Írd meg a deklarációt**

`extensions/crm/src/agents.mjs`. A rendszerprompt a lényeg: **ez tartja fenn azt a határt, amit az eszközök nem tudnak.**

```js
/**
 * Az „Ügyfélkezelő" és a napi rutinja.
 *
 * MIÉRT NINCS HEARTBEAT. A spec `heartbeatEnabled: true`-t írt, és az csendben
 * felülíródna: `storage-normalization.ts` minden betöltéskor `false`-ra állítja
 * CLI-provideres ügynöknél, mert egy CLI-provider előfizetést éget, nem
 * API-kulcsot, és egy flottányi autonóm ébredés nem kapcsolódhat be
 * mellékhatásként. Az ütemezés az egyetlen működő út, és az `aisignal` mindkét
 * ügynöke ugyanígy áll.
 *
 * MIÉRT NINCS `mcpServerIds`. A host ismeri a mezőt, de a szerver azonosítója
 * telepítésenként generálódik, tehát egy deklaráció nem tudja megnevezni. Az
 * operátor rendeli hozzá; a telepítő kiírja a bemásolandó blokkot. Ebben a
 * telepítésben ez nem opcionális: minden ügynök `claude-cli`-n fut, tehát az
 * extension `tools` rétegét meg sem kapja, és a CRM eszközeit kizárólag az
 * MCP-hídon át éri el.
 */

const UGYFELKEZELO_SOUL = `Te Gergő ügyfélkezelője vagy. Egy dolgod van: hogy egyetlen ügyfél se maradjon válasz nélkül, és egyetlen elhangzott ígéret se maradjon feladat nélkül.

## Ahogy dolgozol

Mindig a \`crm_attention\`-nel kezdesz. Az megmondja, mi igényel figyelmet, és megmondja azt is, MIÉRT — a sorrend és az indok számolt, nem véleményes.

Ebből **írsz**, nem ebből **következtetsz**. Ne találgass: ne rakj össze magadnak új szempontot, ne rangsorolj át, és ne hozz fel olyat, ami nincs a listán. Ha valami hiányzik a listáról, az nem a te dolgod — az a lekérdezés dolga, és azt jelezni kell, nem pótolni.

Egy soron ennyit tehetsz:
- elolvasod az ügyfél lapját (\`crm_account\`) és ha kell, az idővonalát (\`crm_timeline\`), a teljes szöveget pedig egyesével (\`crm_event_body\`);
- ha az összefoglaló elavult, írsz újat (\`crm_summary_write\`) — csak arról, ami tényleg szerepel az idővonalon;
- ha egy leiratban vagy levélben ígéret hangzott el, rögzíted (\`crm_commitment_write\`), a helyes iránnyal;
- ha van értelmes következő lépés, javaslatot írsz (\`crm_suggestion_write\`), egy mondat indoklással.

## Amit nem tehetsz meg

Nem hozol létre és nem törölsz ügyfelet, kapcsolatot vagy ügyet. Nem állítasz szakaszt és nem zársz ügyet. Nem rendelsz hozzá besorolatlan levelet — az a kapu, ahol ember erősít meg. És **nem fogadod el a saját javaslatodat**: te javasolsz, Gergő dönt, és az ő kattintása az, amiből feladat lesz.

## Ahogy fogalmazol

Magyarul, tegeződve, röviden. Ne írj bevezetőt és ne foglald össze a végén, amit már elmondtál. Egy javaslat egy mondat arról, mit tegyen, és egy mondat arról, miből gondolod. Ha nincs mit javasolni, ezt mondd, és ne találj ki valamit, hogy legyen.

Ha egy adat hiányzik, mondd meg, hogy hiányzik. Egy magabiztosan hangzó tipp attól még rossz, és az ügyfélkezelésben egy rossz tipp többe kerül, mint egy bevallott hiány.`

const NAPI_PROMPT = `Nézd meg, mi igényel figyelmet, és dolgozd fel a lista elejét.

1. Hívd meg a \`crm_attention\`-t.
2. Ha a lista üres, írd meg egy mondatban, hogy most nincs teendő, és fejezd be.
3. Egyébként vedd az első legfeljebb öt sort. Mindegyiknél nézd meg az ügyfél lapját, és ahol indokolt:
   - írj friss összefoglalót, ha a mostani elavult;
   - rögzítsd az ígéreteket, amik a legutóbbi eseményekben elhangzottak;
   - írj egy javaslatot a következő lépésre.
4. A végén foglald össze Gergőnek egy rövid üzenetben, mi az a legfeljebb három dolog, ami ma tényleg számít.

Ne dolgozz fel ötnél többet. Ami ma kimaradt, holnap még mindig ott lesz a listán — egy hosszú futás, ami nem ér a végére, rosszabb, mint egy rövid, ami igen.`

export const AGENTS = Object.freeze([
  Object.freeze({
    agentKey: 'crm-ugyfelkezelo',
    displayName: 'Ügyfélkezelő',
    description: 'Figyeli, mi igényel figyelmet az ügyfeleknél, összefoglal és javasol.',
    systemPrompt: UGYFELKEZELO_SOUL,
    tools: ['crm_attention', 'crm_account', 'crm_timeline', 'crm_event_body', 'crm_search',
            'crm_summary_write', 'crm_commitment_write', 'crm_suggestion_write', 'memory'],
    heartbeatEnabled: false,
  }),
])

export const SCHEDULES = Object.freeze([
  Object.freeze({
    scheduleKey: 'crm-napi-kor',
    displayName: 'CRM: napi kör (08:10)',
    description: 'Végignézi a figyelem-listát, összefoglal és javaslatot ír a legsürgősebbekre.',
    taskPrompt: NAPI_PROMPT,
    taskMode: 'task',
    agentRef: Object.freeze({ resourceKind: 'agent', resourceKey: 'crm-ugyfelkezelo' }),
    scheduleType: 'cron',
    // 08:10, nem 08:00: a kerek óra a legzsúfoltabb perc egy ütemező-ticken, és
    // a tíz perc semmit nem ér a napi körnél, viszont kikerüli a torlódást.
    cron: '10 8 * * *',
    timezone: 'Europe/Budapest',
    status: 'active',
  }),
])
```

`index.mjs`:

```js
import { AGENTS, SCHEDULES } from './src/agents.mjs'
```

**Egy elavult kommentet is javíts ki itt**, amíg a fájlban vagy: a
`settingsFields` fölötti megjegyzés azt írja, hogy a négy küszöböt még semmi
nem olvassa és a figyelem-motor a CRM-3-ban jön. A CRM-3 ez — a 4. feladat
óta olvassa őket. Egy komment, ami a jövőre mutat, miközben a jövő megjött,
a következő olvasót téveszti meg.

és a `managedResources`-ba `agents: AGENTS, schedules: SCHEDULES` (a `projects` és `setupChecks` mellé).

- [ ] **Step 4: A telepítő mondja meg a hátralévő lépést**

`scripts/install.mjs` záró jelentése már kiírja az MCP-blokkot. Egészítsd ki egy mondattal: a CRM projekt és az Ügyfélkezelő ügynök a host reconcile-jakor jön létre (ki-be kapcsolás vagy Reconcile), **és az ügynök addig nem éri el a CRM eszközeit, amíg az MCP-bejegyzést hozzá nem rendeled.** Ez nem opcionális lépés, hanem az, ami nélkül az ügynök némán semmit nem tud csinálni.

- [ ] **Step 5: Futtasd és commitolj**

Run: `cd extensions/crm && node --import tsx --test test/*.test.mjs`

```bash
git add extensions/crm
git commit -F - <<'MSG'
CRM: az Ugyfelkezelo ugynok es a napi rutin

Nincs heartbeat, es ez nem mulasztas: a host CLI-provideren minden
betolteskor false-ra allitana, mert egy CLI-provider elofizetest eget, nem
API-kulcsot. A deklaralt cron-utemezes az egyetlen mukodo ut -- az aisignal
mindket ugynoke ugyanigy all.

A deklaracio nem nevez meg mcpServerIds-t: a szerver azonositoja
telepitesenkent generalodik. Az operator rendeli hozza, es a telepito
kiirja a blokkot -- e nelkul az ugynok neman semmit nem tud csinalni,
mert claude-cli-n fut es az extension tools reteget meg sem kapja.

A rendszerprompt tartja fenn azt a hatart, amit az eszkozok nem tudnak:
javasol, de nem fogadja el a sajat javaslatat.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01F9MRsWs61Sv7Ub4kEJnWsN
MSG
```

---

## Task 7: A feladatlista és a javaslat elfogadása

**Files:**
- Modify: `extensions/crm/src/rpc.mjs`, `extensions/crm/ui/ugyfel-lap.tsx`, `extensions/crm/ui/ma.tsx`
- Test: `extensions/crm/test/rpc.test.mjs`, `extensions/crm/test/ui.test.mjs`

**Interfaces:**
- Produces: rpc `acceptSuggestion({ suggestionId })` → `{ suggestion, taskId }`

**Ez zárja be a kört**, amiért a `managedResources.projects` host-kiegészítés a CRM-1-ben megszületett: a CRM projekt eddig üres volt.

### Előfeltétel: a javaslat tudja meg, melyik ígéretből született

**Ez a feladat egy rést zár be, amit a 6. feladat végrehajtója talált meg.**

A `crm_suggestion_write` ma `trigger_kind`-ot és `trigger_event_id`-t rögzít, de
**nem azt, hogy melyik ígéretből jött a javaslat.** Így amikor az operátor
elfogad egy „ígéret feladat nélkül" javaslatot, a feladat létrejön, de az ígéret
`task_id`-je üresen marad — és a figyelem-lista **örökre újra felhozza ugyanazt
az ígéretet**, akkor is, ha az operátor már intézkedett.

Ez pontosan az a jelenség, ami ellen az egész fázis szól: figyelmeztetés, amit a
használó megtanul átlapozni. Ezért zárjuk itt, nem később.

Négy apró lépés, mielőtt az elfogadás megíródik:

1. **Új v6 migráció** (a v1–v5 bájtra érintetlen):
   ```sql
   ALTER TABLE ext_crm_suggestion ADD COLUMN commitment_id TEXT;
   ```
2. `writeSuggestion` fogadjon `commitmentId`-t (alap `null`) és írja be.
3. `crm_suggestion_write` tegye közzé `commitmentId` néven, a leírásában azzal,
   hogy **kötelező megadni, ha a javaslat a figyelem-lista `sajat_igeret` vagy
   `idegen_igeret` sorából jött** — különben az ígéret nem tud lezárulni.
4. Teszt: `writeSuggestion` `commitmentId`-vel visszaolvasható, és a mező
   `null` marad, ha nem adták meg.

- [ ] **Step 1: Bukó teszt**

```js
test('a javaslat elfogadasa feladatot ker a hosttol, es rogziti az azonositot', async () => {
  const S = memStorage()
  for (const m of MIGRATIONS) S.raw.exec(m.sql)
  const repo = createRepo(S)
  const hivasok = []
  const state = {
    storage: S, repo, log: console, settings: () => ({}),
    fetchImpl: async (url, init) => {
      hivasok.push({ url, body: JSON.parse(init.body) })
      return { ok: true, json: async () => ({ id: 'task_uj' }) }
    },
  }
  const rpc = createRpc(state)
  const acc = repo.createAccount({ name: 'Morvai Kft.' })
  const sug = repo.writeSuggestion({ accountId: acc.id, text: 'Kuldj ajanlatot', reason: '9 napja nema' })

  const out = await rpc.acceptSuggestion({ suggestionId: sug.id })

  assert.equal(out.taskId, 'task_uj')
  assert.equal(repo.listSuggestions({ status: 'new' }).length, 0, 'a javaslat mar nem uj')
  const b = hivasok[0].body
  assert.equal(b.customFields.crm_account, acc.id)
  assert.deepEqual(b.tags, ['crm'])
  assert.ok(b.fingerprint.includes(sug.id), 'a fingerprint a javaslatra mutat, hogy ne szulessen ketszer')
})

test('az igeretbol szuletett javaslat elfogadasa LEZARJA az igeretet is', async () => {
  const S = memStorage()
  for (const m of MIGRATIONS) S.raw.exec(m.sql)
  const repo = createRepo(S)
  const state = {
    storage: S, repo, log: console, settings: () => ({}), portFile: '/tmp/nincs',
    fetchImpl: async () => ({ ok: true, json: async () => ({ id: 'task_uj' }) }),
  }
  const rpc = createRpc(state)
  const acc = repo.createAccount({ name: 'X' })
  const { event } = repo.recordEvent({ accountId: acc.id, kind: 'meeting',
    occurredAt: '2026-09-01T10:00:00.000Z', excerpt: 'x', sourceSystem: 'manual', sourceId: 'm1' })
  const igeret = repo.writeCommitment({ accountId: acc.id, eventId: event.id, text: 'Kuldom', direction: 'ours' })
  const sug = repo.writeSuggestion({ accountId: acc.id, text: 'Kuldd el', commitmentId: igeret.id })

  assert.equal(repo.listCommitments({ openOnly: true }).length, 1, 'elotte meg nyitott')
  await rpc.acceptSuggestion({ suggestionId: sug.id })
  assert.equal(repo.listCommitments({ openOnly: true }).length, 0,
    'az igeret lezarult, tehat nem jon vissza a figyelem-listara')
})

test('ismeretlen javaslatra nevesitett hiba', async () => {
  const { rpc } = rpcOf()
  await assert.rejects(() => rpc.acceptSuggestion({ suggestionId: 'sug_nincs' }), /crm_ismeretlen_javaslat/)
})
```

- [ ] **Step 2: Futtasd, hogy lásd a bukást**

Run: `cd extensions/crm && node --import tsx --test test/rpc.test.mjs`
Expected: FAIL — `rpc.acceptSuggestion is not a function`

- [ ] **Step 3: Írd meg az elfogadást**

`src/rpc.mjs`. A feladatot a host `/api/tasks` végpontja hozza létre, a port-fájlon át — az `ExtensionContext` nem ad task-API-t, és extension nem importálhat a host `src/`-jéből.

**A `customFields` átmegy**: a route `{...raw, ...parsed.data}`-t ad tovább, és a `createTaskFromRoute` nevesítve viszi a mezőt (`task-route-service.ts:473`). Ellenőrizd, mielőtt építesz rá.

```js
    /**
     * A javaslat elfogadása — és EZ az, ami feladatot csinál belőle.
     *
     * Az ügynök javasol, az operátor dönt; a döntés helye ez a metódus, és
     * ezért nincs `crm_accept_suggestion` eszköz. A `fingerprint` a javaslatra
     * mutat, tehát ugyanabból kétszer nem lesz két feladat.
     */
    async acceptSuggestion({ suggestionId }) {
      const r = repo()
      const sug = r.listSuggestions({}).find((s) => s.id === suggestionId)
      if (!sug) throw new Error('crm_ismeretlen_javaslat')

      const acc = r.getAccount(sug.account_id)
      const body = {
        title: String(sug.text || '').slice(0, 120),
        description: sug.reason ? `${sug.text}\n\nMiért: ${sug.reason}` : String(sug.text || ''),
        projectId: state.crmProjectId || null,
        tags: ['crm'],
        fingerprint: `crm:suggestion:${sug.id}`,
        customFields: {
          crm_account: sug.account_id,
          ...(sug.deal_id ? { crm_deal: sug.deal_id } : {}),
          ...(sug.trigger_event_id ? { crm_event: sug.trigger_event_id } : {}),
          crm_account_name: acc ? acc.name : '',
        },
      }
      const res = await hostFetch('/api/tasks', body)
      const taskId = res && res.id ? String(res.id) : ''
      if (!taskId) throw new Error('crm_feladat_nem_jott_letre')
      r.setSuggestionStatus(suggestionId, 'accepted')
      // Ha a javaslat egy igeretbol jott, a feladat lezarja azt is. Enelkul a
      // figyelem-lista orokre ujra felhozna ugyanazt az igeretet, mikozben az
      // operator mar intezkedett -- es egy figyelmeztetes, ami nem mulik el,
      // az, amit a hasznalo megtanul atlapozni.
      if (sug.commitment_id) r.linkCommitmentTask(sug.commitment_id, taskId)
      return { suggestion: r.listSuggestions({}).find((s) => s.id === suggestionId), taskId }
    },
```

Ugyanebbe a fájlba, a `createRpc` fölé:

```js
import fs from 'node:fs'

/**
 * Hívás a host saját API-jára, a port-fájlon át.
 *
 * Ez az egyetlen út: az `ExtensionContext` nem ad task-API-t, és egy extension
 * nem importálhat a host `src/`-jéből. Ugyanaz a minta, amit a gmail MCP-shimje
 * használ — a port-fájl a futó szerver egyetlen megbízható önleírása.
 *
 * A `fetchImpl` a teszt varrata: a CRM-1 óta a `state`-en ül, és itt kap
 * először használót. Éles kódban `globalThis.fetch`.
 */
async function hostFetch(state, utvonal, body) {
  const file = state.portFile
  if (!file || !fs.existsSync(file)) throw new Error('crm_nincs_port_fajl')
  let port
  try {
    port = JSON.parse(fs.readFileSync(file, 'utf8')).port
  } catch {
    throw new Error('crm_olvashatatlan_port_fajl')
  }
  if (!port) throw new Error('crm_nincs_port_fajl')

  const kulcs = process.env.ACCESS_KEY || process.env.SWARMCLAW_ACCESS_KEY || ''
  const fetchFn = state.fetchImpl || globalThis.fetch
  const res = await fetchFn(`http://127.0.0.1:${port}${utvonal}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(kulcs ? { 'x-access-key': kulcs } : {}) },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error('crm_host_hivas_sikertelen')
  return res.json()
}

/**
 * A CRM projekt azonosítója, a host projekt-listájából.
 *
 * Nem számoljuk ki: a host a `managedResourceId`-t egy hash-ből képzi, és egy
 * második, kézzel írt példány abban a pillanatban elcsúszna, amint a host
 * megváltoztatja a képzést. Megkérdezzük, és a `state`-en tartjuk — a projekt
 * a telepítés élettartama alatt nem változik.
 */
async function crmProjektId(state) {
  if (state.crmProjectId) return state.crmProjectId
  const lista = await hostFetch(state, '/api/projects', {}).catch(() => null)
  const sorok = Array.isArray(lista) ? lista : Object.values(lista || {})
  const crm = sorok.find((p) => p && p.managedByExtension && p.managedByExtension.resourceKey === 'crm')
  state.crmProjectId = crm ? crm.id : null
  return state.crmProjectId
}
```

**A `/api/projects` GET-et vár, nem POST-ot** — ellenőrizd az útvonalat, és ha GET kell, adj a `hostFetch`-nek egy `method` paramétert alapértelmezett `POST`-tal. A feladat-létrehozás POST.

A `state.portFile` az `index.mjs`-ből jön: a CRM-2-ben már feloldott útvonal ott áll (`resolvePortFile`), csak a `state`-re kell tenni a `setup()`-ban.

- [ ] **Step 4: A feladatlista az ügyfél lapon**

`ui/ugyfel-lap.tsx`: a lap a bejelentkezett origin-en fut, tehát `fetch('/api/tasks')` közvetlenül megy. Szűrj `customFields.crm_account === accountId`-ra, és mutasd a címet, státuszt és a határidőt. Ha üres, mondd meg, hogy még nincs feladat — ne hagyj néma üres dobozt.

- [ ] **Step 5: A söprés-összegzés mutassa a kimenőt is**

`ui/ma.tsx` söprés-toastja ma négy számot ír ki (`scanned`, `recorded`,
`unmatched`, `failed`), a `recordedOut`-ot és a kimenő-kihagyást viszont
eldobja. A CRM-3 „válasz nélküli levél" jelzésének a helyessége azon áll, hogy
a kimenő levelek tényleg bejönnek — ha ez a szám nem látszik, az operátor egy
néma, nullát hozó söprést nem tud megkülönböztetni egy működőtől.

Vedd fel a hiányzó mezőket a toast típusába és a szövegbe. A típus `as`
kasztolással készül, tehát a TypeScript nem szól a hiányzó mezőért — ezért kell
kézzel átnézni, mit ad vissza a `sweepNow`.

- [ ] **Step 6: Az elfogadás gombja a Ma nézeten**

`ui/ma.tsx`: a javaslat mellé „Elfogad" gomb az „Elvet" mellé. Futás közben tiltva, és a válasz feladat-azonosítóját írja ki, hogy az operátor lássa, tényleg született valami.

- [ ] **Step 7: Futtasd és commitolj**

Run: `cd extensions/crm && npm run build && node --import tsx --test test/*.test.mjs`
Run: `npx tsc --noEmit && npx eslint extensions/crm/ && npm run lint:baseline`

```bash
git add extensions/crm
git commit -F - <<'MSG'
CRM: a feladatlista es a javaslat elfogadasa

Ez zarja be a kort, amiert a managedResources.projects host-kiegeszites a
CRM-1-ben megszuletett: a CRM projekt eddig ures volt.

A javaslat elfogadasa az operator kattintasa, es ezert nincs
crm_accept_suggestion eszkoz -- az ugynok javasol, a dontes helye ez a
metodus. A fingerprint a javaslatra mutat, tehat ugyanabbol ketszer nem lesz
ket feladat.

A feladatot a host /api/tasks-a hozza letre a port-fajlon at: az
ExtensionContext nem ad task-API-t, es extension nem importalhat a host
src/-jebol. A fetchImpl varrat a CRM-1 ota a tervben van, most kap eloszor
hasznalot.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01F9MRsWs61Sv7Ub4kEJnWsN
MSG
```

---

## Task 8: Szakaszléptetés a pipeline-ban

**Files:**
- Modify: `extensions/crm/ui/ugyek.tsx`
- Test: `extensions/crm/test/ui.test.mjs`

A CRM-1 óta `updateDeal`-nek nincs hívója. A pipeline négy oszlopot mutat, de kártyát csak felvenni lehet bele — továbbvinni nem.

- [ ] **Step 1: Bukó teszt**

```js
test('a bundle tartalmazza a szakaszleptetest', async () => {
  const out = await bundle({ write: false })
  assert.ok(out.outputFiles[0].text.includes('Tovább'), 'hiányzik a léptető')
})
```

- [ ] **Step 2: Léptetés**

Minden kártyára egy „Tovább" gomb, ami `updateDeal`-t hív a `SZAKASZOK` listában következő szakasszal. Az utolsó szakaszon (`negotiation`) a gomb nem jelenik meg — onnan a `closeDeal` visz tovább, és egy gomb, ami nem visz sehova, ugyanaz a hiba, amit ez a projekt már háromszor javított.

Hiba esetén `setHiba(e.message)`, siker esetén `tolt()`.

- [ ] **Step 3: Futtasd és commitolj**

Run: `cd extensions/crm && npm run build && node --import tsx --test test/*.test.mjs`

```bash
git add extensions/crm
git commit -F - <<'MSG'
CRM: szakaszleptetes a pipeline-ban

A CRM-1 ota updateDeal-nek nem volt hivoja: a pipeline negy oszlopot mutat,
de kartyat csak felvenni lehetett bele, tovabbvinni nem.

Az utolso szakaszon nincs "Tovabb" gomb -- onnan a lezaras visz tovabb, es
egy gomb, ami nem visz sehova, ugyanaz a hiba, amit ez a projekt mar
haromszor javitott.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01F9MRsWs61Sv7Ub4kEJnWsN
MSG
```

---

## Amit a CRM-3 szándékosan nem tartalmaz

| Kimarad | Hova |
|---|---|
| A TranscripTonic webhook, a token, a naptár, a meeting-eligazítás | CRM-4 |
| `provides` szerződés más extensionöknek | Amikor lesz fogyasztója |
| Kapcsolati ritmus mint trigger | Az operátor a tervezéskor kihagyta |
| Reggeli digest-üzenet | Az operátor a tervezéskor kihagyta; a napi rutin zárása pótolja |

## Önellenőrzés — a terv a spec ellen

**Spec-lefedettség.** A spec 12. fejezetének CRM-3 sora: „`crm_attention`, az »Ügyfélkezelő« ügynök deklarációja, összefoglaló és javaslat, ígéret-radar, a feladatlista az ügyfél lapon és a javaslat → `BoardTask`." Rendre: Task 4 (`crm_attention`), Task 6 (ügynök), Task 5 (összefoglaló, javaslat, ígéret), Task 7 (feladatlista és `BoardTask`). A spec 6. fejezetének három triggere a Task 2-ben, a rangsor a Task 3-ban.

**Amit a terv a specen felül vesz fel.** Task 1 (kimenő levelek) — a CRM-2 kizárási táblázata nevesítve ide utalta, mert a „válasz nélküli levél" trigger nélküle nem tud működni. Task 8 (szakaszléptetés) — a CRM-1 óta hívó nélküli `updateDeal`, szintén nevesítve halasztva.

**Két spec-korrekció, a kód alapján.** A `heartbeatEnabled: true` nem valósítható meg (a host felülírja), és az `mcpServerIds` nem deklarálható (telepítésfüggő azonosító). Mindkettő a terv fejlécében indokolva; a spec 5.5 és 10. fejezetét ennek megfelelően frissíteni kell.

**Névegyezés.** A `kind` értékek (`nema_ugy`, `valasz_nelkul`, `sajat_igeret`, `idegen_igeret`) a Task 3 moduljában, a Task 3 tesztjében és a Task 4 eszközleírásában ugyanazok. A `crm_attention` visszatérési alakja (`{ sorok, kuszobok, osszes }`) a Task 4 rpc-jében és eszközében azonos.
