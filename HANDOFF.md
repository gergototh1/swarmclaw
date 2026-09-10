# Handoff: a hivatalos extension-doksi elolvasása, majd a claude-cli híd megépítése

Generálva: 2026-09-06
Innen: Claude Opus 5 (1M context) session `01LnVFFRxaMFKVLGVag5bSte`
Ide: következő session

## Goal

Két dolog, sorrendben.

1. **Olvasd el a `https://www.swarmclaw.ai/docs/extensions` oldalt és MINDEN
   `/docs/` aloldalát.** Ez az egyetlen forrás: a repóban nincs
   extension-szerzői dokumentáció, csak a saját `doc/specs/` és `doc/plans/`
   fájljaink. A domain most már rajta van az engedélylistán, egy friss session
   látni fogja.
2. **Írd be a doksiból kiolvasott tényleges szabályokat a `CLAUDE.md`-be**, hogy
   a jövőben a rendszert kövessük, ne a következtetéseinket. A `CLAUDE.md` és az
   `AGENTS.md` szinkronban kell maradjon — ezt a `CLAUDE.md` maga írja elő.
3. **Utána** építsd meg a hidat (lásd „Next Steps").

## Current Progress

**Kiadva és pusholva** a `gergototh1/swarmclaw` forkra (`origin`; az `upstream`
a `swarmclawai/swarmclaw`, ahhoz nem nyúltunk). `main` és `origin/main` egyezik.

| commit | mi |
|---|---|
| `07983c8` | merge: minden ág a main-re (0 ütközés) |
| `80bd959` | a merge-elt fa tiszta checkoutból is települ és lintel |
| `e3ec9de` | `@types/turndown` — enélkül a teljes build bukott |
| `5567972` | **Release v1.10.0** (tag `v1.10.0` pusholva) |
| `7b214ea` | a tts és gmail modul elhagyja a lapját |
| `f757fd3` | a videó részletnézet szerkezetet kap |

**Új modul: `extensions/docs/` („Doksik").** Markdown-dokumentumkezelő: valódi
`.md` fájlok egy operátor által megadott gyökérben (alap `~/SwarmClaw/docs`), a
DB csak index. WYSIWYG lap `/x/docs`-on, hat ügynök-tool, ügynökönkénti mappa,
verzió-ellenőrzés ütközés-jelzéssel, `[[wiki-linkek]]`, kuka, külső szerkesztés
figyelése. 161 saját teszt. Specifikáció:
`doc/specs/2026-09-05-doksik-extension-design.md`, terv:
`doc/plans/2026-09-05-doksik-extension.md`.

**MCP-k beregisztrálva és host-szinten működnek** (a `/api/mcp-servers/<id>/test`
`ok: true`-t ad, valódi toolokkal):
- `Soniox MCP` → `tts_synthesize`, `tts_status`
- `Gmail MCP` → `gmail_search`, `gmail_read`, `gmail_labels`, `gmail_label`,
  `gmail_draft`, `gmail_outbox` (küldés szándékosan nincs)

Mindkettő `command`-ja `/opt/homebrew/bin/node`, a shim az adatkönyvtárban —
egyik sem hivatkozik a `release/` mappára, tehát túléli az újraépítést.

**Nem a miénk, ne commitold:** `src/lib/server/connectors/telegram.ts` és a két
`telegram-markdown*` fájl — egy másik ügynök dolgozik rajtuk ugyanebben a
checkoutban. A `.eslint-baseline.json` módosítottként látszik; nézd meg, mielőtt
hozzányúlsz.

## What Worked

- **A `git merge-tree --write-tree` ütközés-előrejelzésnek**: 0-val tért vissza,
  és a valódi merge tényleg tiszta volt.
- **A felmérés a merge előtt**: kiderült, hogy `local-install` és mind a három
  `fix/*` ág teljes egészében a `feat/doksik-extension` része, így a 6 ág
  összefésülése 2 ágra redukálódott.
- **Az éles telepítés mint tesztréteg.** Négy hibát csak az talált meg, egységteszt
  egyiket sem: a host kötelező `provides.<név>.summary` mezője; a figyelő
  ENOENT-je friss gyökéren; a vault feloldatlan `root`-ja (`/var` vs
  `/private/var`), ami MINDEN útvonalat kilépésnek ítélt volna; és hogy az
  ügynök neve a tool-ctx `agentRecord`-ján van, nem kívül.
- **Build-kimenet fájlba írása és a VALÓDI kilépési kód olvasása.** A
  `| tail`-en át mért exit-kód a `tail`-é — emiatt egyszer tévesen sikeresnek
  jelentettem egy buildet, ami típushibán bukott.

## What Didn't Work

- **`https://www.swarmclaw.ai/docs/extensions` lekérése ebben a sessionben.** A
  quarantine-reader a domain-listát session-INDULÁSKOR olvassa be egyszer;
  utólagos hozzáadás nem érvényesül. A domain most már MINDKÉT helyen ott van:
  `~/DEV/marveen-migracio-mentes/titkok/egress-allowlist.json` és a renderelt
  `~/.claude/agents/quarantine-reader.md` (utóbbiból hiányzott — a generáló
  lépés nem futott le). **Egy friss session látni fogja.** Ne próbálkozz
  ismételt fetch-csel, az nem lassú propagáció.
- **Élő ügynök-teszt az extension-toolokra**: nem sikerült, lásd a blokkolót.

## A BLOKKOLÓ, amit fel kell oldani

**A `claude-cli` provider nem ad tovább SEMMIT SwarmClaw-oldalról.**

Bizonyíték:
- `src/lib/providers/claude-cli.ts` egyetlen `--mcp-config`-ot ír, azt is csak
  `if (tools.includes('browser'))` ágon, a playwrighthoz.
- A futó rendszer naplójában a CLI minden indulásnál kilogolja a tool-listáját.
  **Az egész `app.log`-ban nulla olyan bejegyzés van, amiben `videoOpen`,
  `videoQueue`, `doksi_*` vagy `signalSweep` szerepelne** — csak a Claude Code
  saját tooljai és a felhasználó személyes `~/.claude.json` MCP-szerverei.

Következmény: a felhasználó mind a 8 ügynöke `claude-cli`-provideres, tehát ma
sem az extension-toolok, sem a most regisztrált SwarmClaw MCP-szerverek nem
jutnak el egyikükhöz sem. A videó napi gyártási lánca így nem tud lefutni, és a
Doksik ügynök-oldala sem használható.

A `session-tools/index.ts` egyetlen LangChain tool-tömböt épít (natív +
extension + MCP `agent.mcpServerIds` szerint) — ezt **csak az API-providerek**
használják.

**Gyanú, amit a doksinak kell eldöntenie:** a `tts` és a `gmail` modulnak van
`mcp/server.mjs` shimje, a `video`, `aisignal` és `docs` modulnak nincs. Ha a
hivatalos doksi szerint az MCP-shim A kötelező út az ügynökök felé, akkor a
három modul hiányosan készült, és a hidat NEM host-módosításként kell megírni,
hanem shim-generátorként. **Ezt olvasd ki a doksiból, ne feltételezd.**

## Amit az operátor kért, a saját szavaival

Ez a kiinduló probléma; a fenti blokkoló ennek a feltárása közben derült ki.

1. **„nem is igazán látom, hogy most ez hogyan működik, pl gyártásra hogyan
   küldöm a videót?"** — ma sehogy: a lap nem tud videót előre vinni.
2. **„nekem is tudnom kell előre vinni és manuálisan is UI-ról menedzselni, meg
   ügynökkel történő beszélgetés által is"** — MINDKÉT út kell, nem vagylagos.
   A UI-út a videó modul rpc-jének bővítése; a beszélgetés-út a blokkoló
   feloldása.
3. **„hogy tudok új ötleteket bekérni a youtube api-ból?"** és **„ötleteket ne
   csak ai signalból vegyünk, hanem tudjak választani, hogy ai signalból vagy
   youtube apiról, mint a hermesben"** — tehát nem YouTube HELYETT, hanem
   VÁLASZTHATÓ forrás, a Hermes ügynökénél megszokott módon. Érdemes megnézni,
   a Hermes (`GTassistant`, id `c3377d2c`) hogyan csinálja, és ahhoz igazodni.

Két nyitott tervezési kérdés ehhez, amit az operátorral kell tisztázni:
mit keressen a YouTube-ág (megadott csatornák feltöltéseit, vagy kulcsszavas
keresést, mint a HN/Reddit ág), és mi számítson jelnek (megtekintés/kor arány,
vagy csak friss feltöltés).

## Next Steps

1. **Olvasd el a teljes `/docs/` fát a swarmclaw.ai-n**, kiindulva az
   `/docs/extensions` oldalról. Az operátor kifejezetten az ÖSSZES aloldalt kérte.
2. **Írd be a szabályokat a `CLAUDE.md`-be és az `AGENTS.md`-be** (szinkronban).
   A doksi tényleges előírásait, ne a következtetéseket.
3. **Döntsd el a doksi alapján**, hogyan kell egy extension tooljait az
   ügynökökhöz eljuttatni. Ha a shim a kanonikus út: generátor kell, és a
   `video`, `aisignal`, `docs` modul kap egy `mcp/`-t. Ha a host feladata:
   a `claude-cli.ts` bővítése.
4. **Építsd meg a hidat**, és a bizonyíték NE a fordítás legyen: egy
   `claude-cli` ügynök init-eseményének tool-listájában jelenjenek meg a
   modul-toolok (`app.log`, `"tools":[...]`), majd egy élő beszélgetésben hívja
   meg az ügynök a `videoQueue`-t.
5. **Utána** (az operátor sorrendje szerint): (A) UI-gombok a videó
   részletnézetre, hogy kézzel is előre lehessen vinni egy videót — ma a lap
   rpc-jében NINCS `videoOpen`/`videoPlan`/`videoDraft`/`videoNarrate`/
   `videoRender`, csak `feedback`, `lezar`, `cancelRender`, `cleanup`; és
   (C) YouTube mint választható ötletforrás az AI Signal mellé — ma az aisignal
   csak `github`, `hn`, `reddit` forrásból kutat, YouTube-hoz nincs kód.
6. **Ellenőrizd**: a `release/` mappa a v1.10.0 artifactokat tartalmazza; az
   operátornak még telepítenie kell a `SwarmClaw-1.10.0-arm64.dmg`-t.
