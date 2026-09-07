# CRM-extension a SwarmClaw-ban — tervezési specifikáció

Dátum: 2026-09-06. Állapot: tervezési spec, implementáció előtt.

Az operátor kérése az volt, hogy a rendszer kezelje az ügyfeleit és a leadjeit:
figyelje az emailjeit, csináljon leiratot a Meet-megbeszéléseiről, rendeljen
minden levelet, leiratot és feladatot ügyfélhez, tartson róluk naprakész
összefoglalót, és legyen proaktív — javasoljon következő lépéseket.

A minta a `gmail` extension (`extensions/gmail/`, kész): **egy hitelesítés,
szerződés a kódnak és MCP-szerver az ügynököknek**, plusz az a fegyelem, hogy
amit nem lehet biztosan tudni, azt nem találjuk ki. Ahol ez a spec eltér tőle,
ott megmondja, miért.

Ez a dokumentum **egy extension** tervét írja le. A négyes fázisbontás
szállítási sorrend, nem négy modul: közös az adatmodell és közös az oldal.

---

## 1. Mi ez, és mi nem

### 1.1 A központi elv

**A kiváltó ok determinisztikus, a fogalmazás LLM.**

Ez nem stílusdöntés, hanem ez tartja életben az egészet. Az ügynök nem olvassa
végig minden heartbeat-ciklusban az összes ügyfelet — ez drága, lassú, és a
minősége a napi modellformától függ. Helyette a CRM **SQL-ben kiszámolja**, mi
igényel figyelmet, és egy rangsorolt listát ad át. Az ügynök ebből *ír*, nem
ebből *következtet*.

Következménye: a jelzés akkor is helyes, ha a modell aznap gyengébb. A modell
azt befolyásolja, milyen jól van megfogalmazva a mondat, nem azt, hogy egyáltalán
szólunk-e.

### 1.2 Amit szándékosan nem csinálunk

**Nem találgatjuk LLM-mel, kihez tartozik egy levél.** Egy rosszul besorolt
email beleírja az egyik ügyfél adatát a másik összefoglalójába, és csendben
teszi. Ez a legrosszabb hiba, amit egy CRM elkövethet: nem elromlik tőle a
rendszer, hanem *hazudik*, miközben működőnek látszik. A hozzárendelés ezért
végig determinisztikus, és ahol nem biztos, ott megáll (3. fejezet).

**Nem építünk saját feladat-modult.** A host `BoardTask`-ja végrehajtható
egység; egy CRM-lokális feladat-tábla halott jegyzet lenne (4. fejezet).

**Nem építünk saját leiratozót.** Egy karbantartott upstream Chrome-kiegészítő
adja a leiratot webhookon (7. fejezet).

### 1.3 Hol fut

Ma az operátor gépén, desktop appként; később szerveren. A terv úgy készül,
hogy **működjön a desktopon, de semmi ne kösse oda**: minden állapot a
`SWARMCLAW_HOME` alatt van, semmi nem függ a gép hangeszközétől, képernyőjétől
vagy egy felhasználói gesztustól, és semmi nem igényel natív binárist.

---

## 2. A rendszer alakja

```
  gmail extension ──(MAILBOX_CONTRACT, consumes)──┐
  TranscripTonic  ──(webhook POST)────────────────┤
  Google Calendar ──(saját OAuth purpose)─────────┤
                                                   ▼
                                          ┌─── CRM extension ───┐
                                          │ tár (ext_crm_*)     │
                                          │ oldal /x/crm        │
                                          │ tools + MCP         │
                                          └─────────┬───────────┘
                                    managedResources │ deklarálja
                                                     ▼
                              „Ügyfélkezelő" ügynök + „CRM" projekt
                                        └─▶ chat / Telegram
```

Öt réteg, éles határokkal:

| Réteg | Feladata | Mit **nem** csinál |
|---|---|---|
| **Tár** | Táblák, migrációk, lekérdezések | Nem hív LLM-et, nem megy ki a hálózatra |
| **Behúzás** | Email / leirat / naptár → esemény + hozzárendelés | Nem találgat: bizonytalanság esetén besorolatlan |
| **Oldal** | Amit az operátor lát, és amit csak ő tehet meg | Nem tartalmaz üzleti logikát |
| **Tools/MCP** | Amit az ügynök olvashat és írhat | Nem töröl, nem zár ügyet |
| **Manifest** | Ügynök, projekt, előfeltételek deklarálása | Nem indít timert a `setup()`-ban |

### 2.1 A `setup()` fegyelme

A host minden reloadkor újrahívja a `setup()`-ot, fejlesztés közben mentésenként
kétszer. Ezért a `setup()` **szinkron és üres**: csak a modul-szintű `state`
objektumot tölti. Se timer, se listener, se subscription — az reloadonként
szivárogna egyet. A söprést a deklarált schedule hajtja, nem a `setup()`.

Ugyanez a szabály teszi kötelezővé, hogy minden behúzás idempotens legyen: az
`event` és az `inbox_unmatched` táblán `UNIQUE(source_system, source_id)` áll,
tehát egy söprést kétszer lefuttatni ingyenes.

---

## 3. Adatmodell és hozzárendelés

Tíz tábla, a hosttól kapott `ctx.tablePrefix` előtaggal (`ext_crm_`).
**A mezőnevek angolul**, a dokumentáció és a felület magyarul.

### 3.1 A táblák

| Tábla | Kulcsmezők | Miért így |
|---|---|---|
| `account` | `type: company\|person`, `status: lead\|client\|inactive\|lost`, `name`, `domains` | Egy KKV-tanácsadónál sok „ügyfél" egyetlen ember; cégbe kényszeríteni őket felesleges súrlódás |
| `contact` | `account_id` **nullable**, `name`, `phone`, `role`, `notes` | Létezhet, mielőtt tudnánk, kihez tartozik |
| `contact_email` | `address` **UNIQUE**, `contact_id`, `source: manual\|learned` | Külön tábla, mert ez a hozzárendelés O(1) kulcsa, és az UNIQUE kikényszeríti, hogy egy cím egy emberhez tartozzon |
| `deal` | `account_id`, `kind: lead\|engagement`, `stage`, `value_huf`, `expected_close`, `close_reason` | A `kind` hordozza a két életszakaszt: a nyert lead megbízást szül |
| `event` | `account_id`, `deal_id`, `contact_id`, `kind`, `occurred_at`, `title`, `excerpt`, **`UNIQUE(source_system, source_id)`** | Az idővonal. Az unique index az egyetlen védelem a duplikáció ellen |
| `event_body` | `event_id`, `content` | A teljes levél / teljes leirat. Külön tábla, hogy az idővonal-lekérdezés soha ne rángasson megabájtokat |
| `commitment` | `event_id`, `text`, `direction: ours\|theirs`, `due_hint`, `task_id` **nullable**, `status` | Az elhangzott ígéret. A hiányzó `task_id` maga egy trigger |
| `summary` | `account_id`, `text`, `covers_event_id`, `covers_event_at`, `generated_by_agent_id` | A `covers_event_at` mondja meg, elavult-e |
| `suggestion` | `text`, `reason`, `trigger`, `trigger_event_id`, `status: new\|accepted\|dismissed` | Az elvetést az ügynök is látja, tehát nem ismétli |
| `inbox_unmatched` | **`UNIQUE(source_system, source_id)`**, `sender_address`, `sender_name`, `subject`, `excerpt`, `guess_account_id`, `state` | Ez tartja őszintén az egészet |

### 3.2 Az összefoglaló frissessége nem becslés

A `summary.covers_event_at` a legfrissebb esemény ideje, amit az összefoglaló
lefed. Az oldal ezt veti össze az ügyfél legutolsó eseményének idejével, és ha
van újabb, kiírja: „elavult, 3 új esemény óta". Ez egy `MAX()`, nulla token.

**A `covers_event_id`-t a szerver bélyegzi rá, nem az ügynök.** Így az ügynök
nem állíthatja, hogy többet fedett le, mint amennyit elolvasott — és az
elavultság-jelzés ettől lesz megbízható, nem udvariassági kérdés.

### 3.3 A hozzárendelési lánc

Első találat nyer:

```
1. Pontos cím egyezés (contact_email.address)      → biztos
2. Ugyanaz a szál, korábbi üzenete besorolva       → biztos
   ↳ elkapja: „a szál közepén magánemailre váltott"
3. Domain egyezés (account.domains)                → gyanú
   ↳ SOHA a közösségi domainekre (gmail.com, freemail.hu,
     citromail.hu, outlook.com, hotmail.com, yahoo.*, icloud.com)
4. Semmi                                            → inbox_unmatched
```

**A 3. lépés nem sorol be automatikusan.** Ismeretlen címről érkező levél ismert
domainről a besorolatlan sorba kerül, de már a tippel: `guess_account_id`
kitöltve. Egy kattintással megerősíted.

Ennek az ára egy kattintás feladónként, egyszer az életben. Amit cserébe kapsz:
a `noreply@`, a cég könyvelője és a külsős alvállalkozó **nem kerül** az ügyfél
idővonalára, és onnan az összefoglalójába.

### 3.4 A besorolatlan sor mint tanulómechanizmus

Amikor az operátor hozzárendel egy besorolatlan levelet, a cím bekerül
`contact_email`-be `source='learned'`-del. Ugyanaz a feladó legközelebb már az
1. lépésen fennakad. **A sor magától apad**, és nem válik olyan feladatlistává,
amit az ember egy hét után abbahagy.

---

## 4. Feladatok: a host modulja, nem sajátunk

### 4.1 Miért nem építünk sajátot

A host `BoardTask`-ja (`src/types/task.ts`) nem jegyzet, hanem **végrehajtható
egység**: `agentId`, `attempts`/`maxAttempts`/`retryBackoffSec`,
`blockedBy`/`blocks`, `qualityGate`, `executionPolicy`, `executionWorkspace`,
delegálási lánc, `result`, `artifacts`. Az ügynököknek megvannak hozzá az
eszközeik (`session-tools/delegate.ts` és a task-CRUD).

Az operátor kérése az volt, hogy *„az ügynököknek feladatot is meg kell tudniuk
csinálni, ha kérem őket"*. Ezt csak ez adja meg. Egy `ext_crm_task` tábla halott
jegyzet lenne, és két helyen kellene feladatot keresni.

### 4.2 A kapcsolás

```js
customFields: { crm_account: 'acc_…', crm_deal: 'deal_…', crm_event: 'evt_…' }
tags:         ['crm']
projectId:    <a CRM projekt id-ja>
fingerprint:  'crm:followup:acc_123:2026-09-14'
```

A `fingerprint` a `BoardTask` saját dedup-mezője: ettől nem hozza létre az
ügynök kétszer ugyanazt az utánakövetést.

A `listTasks()` az egész gyűjteményt memóriába tölti, ezért a
`customFields.crm_account` szerinti szűrés puszta tömbszűrés. **Nincs szükség
saját index-táblára**, és nem is építünk — az két igazságforrás lenne egy
helyett.

### 4.3 Ki hozza létre, ki olvassa

Az `ExtensionContext` **nem ad task-API-t** (`storage`, `settings`, `log`,
`oauth`, `resolveBinary`, `contracts` — más nincs), és extension nem importálhat
a host `src/`-jéből. Ez nem akadály, hanem a helyes irányba terel:

- **Létrehozni az ügynök hozza létre**, a saját eszközeivel. A CRM azt adja neki,
  hogy *mi igényel figyelmet*; a döntés és a végrehajtás az övé.
- **Az oldal olvassa** — a CRM böngésző-bundle a bejelentkezett app origin-jén
  fut, tehát `fetch('/api/tasks')`. Nulla új vezeték.
- **A „lejárt feladat" trigger nem a CRM-é.** A task-modul már ma látja a
  `dueAt`-et. Nem duplikáljuk.

### 4.4 A CRM projekt — és egy host-kiegészítés

Minden CRM-es feladat `projectId`-je a „CRM" projekt. A projektet az extension
hozza létre telepítéskor.

**Ehhez a host `ExtensionManagedResources`-át ki kell egészíteni.** Ma ismer
`agents`, `schedules`/`routines`, `localFolders`, `gatewayPlatforms` és
`setupChecks` deklarációt — projektet nem. A munka:

1. `ExtensionManagedProjectDeclaration` a `src/types/extension.ts`-ben
   (`projectKey`, `displayName`, `description`, `objective`, `priorities`,
   `successMetrics`, `capabilityHints`)
2. `projects?: ExtensionManagedProjectDeclaration[]` a `ExtensionManagedResources`-ban
3. `'project'` ág a `extension-managed-resources.ts` marker-logikájában
   (ma `'agent' | 'schedule'`)
4. `'project'` ág a `extension-managed-teardown.ts`-ben

A 4. pont nem opcionális, és ez a döntés indoka. A
`extension-managed-teardown.ts` fejléce pontosan azt a hibaosztályt írja le,
ami teardown nélkül keletkezik: az uninstall után ott marad egy projekt, benne
CRM-es feladatokkal, amikhez már nincs se tábla, se ügynök, se oldal.

A `Project` típus `objective`, `priorities`, `successMetrics` és
`capabilityHints` mezői miatt a deklaráció **egyben eligazítás is** az
ügynöknek — a `project-context.ts` élesben beolvassa.

---

## 5. Az ügynök felülete

Egy implementáció, két ajtó: `tools` a házon belüli ügynöknek, MCP-szerver a
külsőnek.

### 5.1 Miért van `tools`, a gmail mintájával szemben

A gmail extension szándékosan nem ad `tools`-t: nem akarta tudni, melyik ügynök
hívta. A CRM-nél ez fordítva van. Az `ExtensionToolDef.execute(args, ctx)`
megkapja a `ctx.session`-t, és **hasznos rögzíteni, melyik ügynök írt egy
összefoglalót vagy javasolt egy feladatot** — az idővonalon így elválik az
emberi és a gépi bejegyzés. A `summary.generated_by_agent_id` és a
`suggestion` `agent_id`-ja enélkül nem lenne kitölthető.

### 5.2 Olvasó felület

| Metódus | Mit ad |
|---|---|
| `crm_search` | ügyfél / kapcsolat / ügy keresés |
| `crm_account` | egy ügyfél teljes lapja: profil, nyitott ügyek, utolsó N esemény, aktuális összefoglaló **és hogy elavult-e**, nyitott ígéretek |
| `crm_timeline` | lapozható eseménylista, kivonatokkal |
| `crm_event_body` | a teljes levél / teljes leirat |
| `crm_attention` | a rangsorolt figyelem-lista |

A `crm_event_body` **külön hívás, szándékosan**. Ha az idővonal maga hozná a
teljes szövegeket, egy húsz levelet és három leiratot tartalmazó ügyfél
kontextus-ablakot töltene minden lekérdezésnél. Így az ügynök a kivonatok
alapján dönti el, mit akar tényleg elolvasni.

### 5.3 Író felület

| Metódus | Mit ír |
|---|---|
| `crm_note` | jegyzet-esemény |
| `crm_summary_write` | összefoglaló (a `covers_event_id`-t a szerver bélyegzi) |
| `crm_commitment_write` | kinyert ígéret, `direction: ours\|theirs` |
| `crm_commitment_link` | ígéret ↔ létrehozott `BoardTask` |
| `crm_suggestion_write` | javaslat az operátornak |

### 5.4 Amit az ügynök nem tehet meg

- ügyfelet, kapcsolatot, ügyet létrehozni vagy törölni
- `deal.stage`-et vagy `account.status`-t állítani — a nyerés és a vesztés az
  operátor döntése
- besorolatlan levelet ügyfélhez rendelni — ez a tanuló-kapu, és ha az ügynök
  átlépheti, akkor nincs kapu
- törölni bármit
- a saját javaslatát elfogadni

### 5.5 A javasol/cselekszik határ, és mit tart fenn valójában

*(A CRM-3 után átírva. A korábbi szöveg azt állította biztonsági
tulajdonságként, hogy „a CRM maga ne tudjon feladatot gyártani — és nem is tud,
mert az `ExtensionContext`-ben nincs task-API". Ez már nem igaz, és a helyére
egy szűkebb, de valódi állítás lép.)*

Az ütemezett körében futó ügynök **javasol**: `suggestion` sorokat ír. Feladat
abból akkor lesz, amikor **az operátor a lapon rákattint az Elfogad gombra** —
ez hívja a `rpc.mjs` `acceptSuggestion`-jét, ami valódi `BoardTask`-ot hoz létre
a CRM projektben.

**A CRM tehát TUD feladatot gyártani, és a hoszt HTTP route-ján teszi.**
`acceptSuggestion` a hoszt `POST /api/tasks` végpontjára küld, a portot a
`run/port.json`-ból olvasva; ez nem az `ExtensionContext`-en át megy, mert ott
tényleg nincs task-API — de a hiánya nem korlát, csak egy be nem járt út. Aki
ezt a bekezdést olvassa, ne tervezzen olyan korlátra, ami nem létezik: ha egy
jövőbeli lépésnek feladatot kell írnia, az ugyanezen az úton fog.

**Amit valóban ki lehet kényszeríteni, az kettő, és mindkettő ki is van
kényszerítve:**

1. **Az ügynök nem fogadhatja el a saját javaslatát.** Nincs
   `crm_accept_suggestion` eszköz, és az `acceptSuggestion` nem eszköz, hanem
   rpc-metódus — az rpc a lap ajtaja, az eszköztábla az ügynöké, és a kettő két
   külön fájl (`src/rpc.mjs`, `src/tools.mjs`), hogy egy átvitel a diffből
   látsszon, ne egy megosztott listából.
2. **„Elfogadott" javaslat nem létezhet feladat nélkül.** Ez az invariáns az
   `acceptSuggestion`-ben áll, ezért az operátor-ajtó `setSuggestionStatus`-a is
   elutasítja az `'accepted'` állapotot (`crm_elfogadas_csak_acceptSuggestion`):
   egy státusz-átírás eltüntetné a javaslatot a listáról (az csak a
   `status = 'new'` sorokat mutatja), az ígéretet nyitva hagyná, és semmi nem
   mondaná meg, hogy a munka elveszett.

Ez a határ **nem az eszközhatáron és nem is csak a rendszerprompton áll**: az
ajtó tényleg nincs meg az ügynök felé. A rendszerprompt ezt kimondja, de nem ő
tartja.

---

## 6. Proaktivitás: a három trigger

Mind determinisztikus SQL, a `crm_attention` adja vissza rangsorolva.

1. **Néma aktív ügy** — nincs `event` egy nyitott `deal`-en (alapérték: 9 nap)
2. **Válasz nélküli bejövő levél** — nincs kimenő `event` a szálban (alapérték: 3 nap)
3. **Ígéret feladat nélkül** — `commitment` ahol `task_id IS NULL`, `direction='ours'`,
   és az `event` óta eltelt idő meghaladja a küszöböt (alapérték: 2 nap)

Mindhárom küszöb `settingsFields`-ből jön; a zárójeles értékek a
`defaultValue`-k. A 3. trigger `direction='theirs'` párja külön küszöbbel fut
(alapérték: 7 nap), mert egy tőlünk elvárt dolog és egy nekünk ígért dolog nem
egyforma sürgős.

### 6.1 A napi kör, és miért nem digest

*(A CRM-3 után átírva. A korábbi szöveg azt mondta, hogy „nincs reggeli kör" —
a 6. feladat pontosan egyet szállított, `CRM: napi kör (08:10)` néven.)*

**Van reggeli kör: egy deklarált cron-ütemezés, `10 8 * * *`,
`Europe/Budapest`** (`src/agents.mjs` `SCHEDULES`). Nem tervmódosítás, hanem
kényszer: a mechanizmus, amit az eredeti szöveg feltételezett — az ügynök
magától ébred, amikor valami átlép egy küszöböt — CLI-provideres ügynökön nem
létezik. A `heartbeatEnabled` minden betöltéskor `false`-ra áll (lásd 15.
fejezet), tehát az ébresztés vagy ütemezésből jön, vagy sehonnan. A választás
nem „esemény vs. napi adag" volt, hanem „napi kör vs. semmi".

**A kifogás a digest ellen viszont áll, és ezért a kör nem digest.** Egy napi
összefoglaló, amiben többnyire nincs teendő, néhány hét alatt olvasatlanná
válik. Három dolog tartja ettől távol:

- **A lista rangsorolt és determinisztikus**, nem az ügynök válogatása
  (`src/attention.mjs`): a típus adja a súlyt, a kor a finomhangolást. Az
  ügynök ebből **ír**, nem ebből **következtet**.
- **A lista fogy.** Minden sora egy átlépett küszöb — nem „minden ügyfél
  állapota", hanem az, ami elmaradt. Ha nincs elmaradás, a lista üres, és a
  prompt ilyenkor egy mondatot kér, nem jelentést.
- **A kör felül van korlátozva.** A napi prompt legfeljebb öt sort dolgoztat
  fel, és a záró üzenet legfeljebb három dolgot nevez meg. Ami ma kimaradt,
  holnap még mindig a lista tetején lesz — a rangsor a kor szerint egyre előrébb
  hozza. Egy hosszú futás, ami nem ér a végére, rosszabb, mint egy rövid, ami
  igen.

Ugyanez a lista az operátor lapján is ott van („Figyelmet igényel", `ui/ma.tsx`),
ugyanabból az rpc-ből (`attention`), ugyanabban a sorrendben. Ez nem
kényelmi duplikáció: e nélkül a 08:10-es üzenet **ellenőrizhetetlen** lenne, és
egy ellenőrizhetetlen napi üzenet pontosan az, ami néhány hét alatt elveszíti a
hitelét.

### 6.2 Ígéret-radar mindkét irányba

A `direction: 'theirs'` legalább annyit ér, mint az `'ours'`: *mit ígértek
neked, és nem adtak át*. Ezt jellemzően senki nem tartja számon, és tipikusan
itt akadnak el az ügyek.

Ez a leiratok beszélőnév-mezőjén áll (7. fejezet): enélkül a modellnek kellene
kitalálnia a szövegből, ki ígért, ami pont az a fajta találgatás, amit az 1.2
kizár.

---

## 7. Meet-leiratok: TranscripTonic webhook

### 7.1 A választás

A leiratot a [TranscripTonic](https://github.com/vivek-nexus/transcriptonic)
adja (MIT, Chrome Web Store). A Google Meet **saját feliratát** olvassa ki, és a
kész leiratot webhookon POST-olja.

Amit ez ad, és amiért ez nyert:

| | |
|---|---|
| Bot a résztvevők közt | nincs |
| Hang kiküldve bárhova | nincs — nem hang, felirat |
| STT-számla | nincs |
| Docker / GPU / VPS | nincs |
| macOS engedély, virtuális hangeszköz | nincs |
| Böngésző-gesztus, nyitva tartott fül | nincs |
| Törékeny DOM-kód **nálunk** | nincs — upstream gondja, és ő karbantartja |
| Workspace-előfizetés | nem kell (gmail.com fiókkal is megy) |
| Magyar | megy — a Meet felirata támogatja, és az alapfelirat ingyenes |

A `operationMode: "auto"` és az `autoPostWebhookAfterMeeting` beállításokkal
magától indul és magától küld: nulla kattintás.

Elvetett alternatívák, a döntés indokával: a **Vexa** botot küld a hívásba és
szervert kér (4 CPU / 8 GB); a **Meetily** és az **anarlog** külön desktop app
natív hangfelvétellel és macOS-engedéllyel; a saját **Playwright-bot** a Meet
DOM-jára épült volna, amit nekünk kellene karbantartani; a **Drive-felvétel**
Workspace Business Standard előfizetést kér, ami nincs.

### 7.2 A payload

```js
{
  webhookBodyType: "advanced",
  meetingSoftware:       "Google Meet" | "Teams" | "Zoom",
  meetingTitle:          "Kickoff — Morvai Dorina",
  meetingStartTimestamp: "2026-09-14T12:00:03.000Z",
  meetingEndTimestamp:   "2026-09-14T12:47:11.000Z",
  transcript: [
    { personName: "Morvai Dorina", timestamp: "…", transcriptText: "…" }
  ],
  chatMessages: [
    { personName: "…", timestamp: "…", chatMessageText: "…" }
  ]
}
```

**Beszélőnév minden blokkon** — ez adja ingyen a beszélő-szétválasztást, ami a
6.2 ígéret-radarjának a feltétele. A hívás-chat is jön. És nem csak Meet:
Teams és Zoom is.

### 7.3 A beviteli végpont és a token

A Chrome-kiegészítő a böngésző háttérkontextusából POST-ol, tehát **nem viszi a
bejelentkezett munkamenet sütijét**. Az `/api/extensions/<id>/call/<method>`
útvonal a session-re épül, ezért ide külön, tokennel őrzött végpont kell.

A terv: a token a `settingsFields` `secret` típusú mezőjében él. Ha a mező
üres, a **Beállítás nézet első megnyitása** generál bele egy hosszú véletlen
értéket egy rpc-hívással — nem a `setup()`, mert az minden reloadkor újrafut, és
egy ott generált token minden mentésnél elszakadna a már beállított
kiegészítőtől.

Az oldal a teljes webhook-URL-t másolható formában mutatja, tokenestül. A
bevitel `crypto.timingSafeEqual`-lal ellenőriz, és token nélküli vagy rossz
tokenű hívásra nevesített hibát ad, nem 404-et: egy néma elutasítás
megkülönböztethetetlen a rosszul beírt URL-től.

A payload **idegen szöveg, tehát adat**: zod-sémával validáljuk, és semmilyen
mezője nem kerül promptba anélkül, hogy adatként lenne megjelölve — ugyanaz a
szabály, amit az `aisignal` extension követ.

### 7.4 Hozzárendelés és az elmaradt leirat

A leirat ügyfélhez rendelése: a `meetingStartTimestamp` körüli naptár-esemény
résztvevői, majd a `transcript[].personName` nevek a `contact` táblában. Ha
egyik sem dönt, a leirat is `inbox_unmatched`-be megy — nem tippelünk.

Ha egy naptárban szereplő hívásra nem érkezik webhook (a kiegészítő nem futott,
a felirat nem indult el), a CRM **„elmaradt leirat" eseményt ír** az idővonalra.
Az idővonal így akkor is hű marad: látszik, hogy a megbeszélés megtörtént, és
látszik, hogy nincs róla leirat. Csend helyett tény.

---

## 8. Naptár és a meeting előtti eligazítás

A CRM saját OAuth-purpose-szal olvassa a Google Calendart (`ctx.oauth`). Nem a
host `google_workspace` eszközét használja: az az *ügynök* eszköze és külső
`gws` binárist igényel, a szerveroldali figyeléshez a Calendar API a tisztább,
bináris-függés nélkül.

**Az eligazítás:** 15 perccel a hívás előtt az ügynök üzenetet küld — kik ők,
hol tart az ügy, mi hangzott el legutóbb, mit ígértél és még nem adtál át, és a
nyitott kérdések. Minden adat ehhez már a modellben van; ez a fejezet csak az
időzítést és a naptár-olvasást adja hozzá.

A naptár ezen kívül két helyen dolgozik: a leirat hozzárendelésénél (7.4) és az
elmaradt leirat észlelésénél.

---

## 9. Az oldal

`/x/crm`, öt nézet:

| Nézet | Tartalma |
|---|---|
| **Ma** | figyelem-lista, besorolatlan sor, mai naptár |
| **Ügyfelek** | lista státusz szerint szűrve |
| **Ügyfél lap** | profil · összefoglaló + elavultság-jelzés · idővonal · nyitott ígéretek mindkét irányba · feladatok · javaslatok |
| **Ügyek** | lead-pipeline szakaszonként + futó megbízások |
| **Beállítás** | webhook-URL és token másolható formában, előfeltétel-állapotok |

A feladatok a host `/api/tasks`-ából jönnek, `customFields.crm_account`-ra
szűrve.

A javaslat elfogadása itt történik, és **ez a kattintás hozza létre a
feladatot** — nem az ügynök magától.

### 9.1 Előfeltételek láthatóan

`setupChecks` deklarációval, az extension kártyáján:

- Google OAuth kliens konfigurálva (`kind: 'env'`)
- Google Calendar hitelesítés megvan
- Gmail extension telepítve és engedélyezve
- Webhook-token beállítva, és érkezett-e már rá bejövő hívás

Ha a gmail extension ki van kapcsolva, a `ctx.contracts.get` `null`-t ad, és az
oldal ezt **kiírja**: „az email-behúzás áll, mert a Gmail extension ki van
kapcsolva". A `consumes` dokumentációja pontosan ezt írja elő: az operátort
jobban szolgálja egy megnevezett korlát, mint egy modul, ami csendben nem indul
el.

---

## 10. A manifest

```js
{
  name: 'CRM',
  migrations: MIGRATIONS,
  setup,                       // szinkron, idempotens, üres
  tools:    createTools(state),
  rpc:      createRpc(state),  // az oldalé + a webhook-bevitel
  consumes: [{ contract: MAILBOX_CONTRACT, version: '…', reason: '…' }],
  managedResources: {
    projects:  [{ projectKey: 'crm', displayName: 'CRM', objective: …, priorities: … }],
    agents:    AGENTS,      // src/agents.mjs
    schedules: SCHEDULES,   // src/agents.mjs
    setupChecks: [ … ],
  },
  ui: { pages: [{ id: 'crm', path: '/x/crm', icon: …, entry: 'dist/index.js' }],
        settingsFields: [ … ] },
}
```

Az ügynök- és ütemezés-deklaráció a `src/agents.mjs`-ben áll, nem itt beágyazva
— egy rendszerprompt hosszú, és a manifestben olvashatatlanná tenné azt a
néhány mezőt, ami a hosztnak tényleg szól. Amit ez a két konstans visz:

```js
AGENTS    = [{ agentKey: 'crm-ugyfelkezelo', displayName: 'Ügyfélkezelő',
               systemPrompt: …, tools: ['crm.mjs', 'memory'],
               heartbeatEnabled: false }]
SCHEDULES = [{ scheduleKey: 'crm-napi-kor', displayName: 'CRM: napi kör (08:10)',
               agentRef: { resourceKind: 'agent', resourceKey: 'crm-ugyfelkezelo' },
               scheduleType: 'cron', cron: '10 8 * * *',
               timezone: 'Europe/Budapest', status: 'active', taskPrompt: … }]
```

Három eltérés a fenti eredeti vázlathoz képest, mindhárom a kód szerint:

**`crm-ugyfelkezelo`, nem `crm-manager`.** Az `agentKey` a managed-resource
azonosítója, amin a reconcile az ügynököt megtalálja és frissíti; egy átnevezés
nem átnevez, hanem egy második ügynököt hoz létre az első mellé. A magyar
kulcsot a `test/agents.test.mjs` pineli.

**`heartbeatEnabled: false`, és ez marad.** A `true` némán felülíródna:
`storage-normalization.ts` minden betöltéskor `false`-ra állítja CLI-provideres
ügynöknél. Az ok viszont nem csak mechanikus, és ezért nem is „kerülendő
korlát": **egy CLI-provider előfizetést éget, nem API-kulcsot**, tehát egy
flottányi autonóm ébredés nem kapcsolódhat be mellékhatásként — sem egy
extension telepítéséből, sem a delegálás engedélyezéséből. Az ébresztés a
`SCHEDULES` cronjából jön, ami egy megnevezett, naponta egyszeri, az operátor
által a felületen látható és kikapcsolható esemény. (Részletesen: 15. fejezet.)

**`dailyBudget` nincs.** A vázlat felsorolta, a szállított deklaráció nem viszi:
a napi költséget az egyetlen ütemezett futás korlátozza, és a napi prompt maga
is legfeljebb öt sort dolgoztat fel. Egy második, számokban kifejezett korlát
egy naponta egyszer futó ügynöknél olyan mező, amit senki nem hangol.

A `provides` szerződés az első négy fázisban nem szerepel: ma nincs fogyasztója,
és egy szerződés-metódus, amit senki nem hív, olyan felület, amit senki nem
figyel. Amikor lesz fogyasztó, akkor kerül be — a gmail `contract.mjs`-ének
indoklásával azonos okból.

**Az extension külső, nem builtin.** A builtin ág a `provides`-t és az `rpc`-t
nem viszi tovább; a telepítés a gmail útját másolja (`scripts/build.mjs` +
`scripts/install.mjs`).

---

## 11. Hibatűrés és tesztelés

- **Minden behúzás idempotens** az `UNIQUE(source_system, source_id)` miatt.
- **A `setup()` üres és szinkron** (2.1).
- **Hiányzó szerződés nem csend**, hanem megnevezett korlát az oldalon (9.1).
- **Az idegen szöveg adat**: a webhook-payload és az email-tartalom
  zod-validált, és promptba csak adatként jelölve kerül.

Tesztek a gmail mintájára: `test/*.test.mjs` `node:test`-tel, plusz
`deploy.smoke.mjs` és `e2e.smoke.mjs` futó host ellen.

**A hozzárendelési lánc táblázatos tesztet kap.** Ez a legkockázatosabb logika
az egészben, mert a hibája nem látszik: egy rosszul besorolt levél működő
rendszernek látszik, csak rossz adatot ír. A tesztnek le kell fednie mindkét
biztos ágat, a domain-tippet, a közösségi domainek kizárását, a szál-közbeni
címváltást, és a tanult cím visszahatását.

Hálózat nincs a unit tesztekben: `fetchImpl` seam a `state`-en, ahogy a gmail
csinálja.

---

## 12. Szállítási fázisok

Ez a dokumentum a közös terv mind a négy fázisra. Fázisonként **külön
kivitelezési terv** készül (`doc/plans/`), nem újabb spec.

| # | Fázis | Tartalma |
|---|---|---|
| **CRM-1** | **Mag** | Táblák, migrációk, oldal, **teljes kézi bevitel** (ügyfél, kapcsolat, email-cím, ügy, jegyzet), olvasó tools, a CRM projekt + a `managedResources.projects` host-kiegészítés. Önmagában használható CRM. |
| **CRM-2** | **Email** | `consumes` a gmail szerződést, hozzárendelési lánc, besorolatlan sor és a tanulás, **plusz az MCP-híd** (lásd lent). |
| **CRM-3** | **Proaktív** | `crm_attention`, az „Ügyfélkezelő" ügynök deklarációja, összefoglaló és javaslat, ígéret-radar, **a feladatlista az ügyfél lapon** (host `/api/tasks`, `customFields.crm_account`) és **a javaslat elfogadása → `BoardTask`**. |
| **CRM-4** | **Leiratok** | Webhook-bevitel és token, naptár-olvasás, meeting-eligazítás, elmaradt leirat. |

A CRM-1..3 semmit nem tud a leiratokról; a CRM-4 külön elvihető vagy elhagyható.

---

## 13. Amit implementáció előtt ellenőrizni kell

Ezek nem nyitott tervezési kérdések, hanem tények, amiket méréssel kell zárni:

1. **A Meet magyar feliratának minősége** egy valódi, zajos hívásban. A
   dokumentáció szerint támogatott, de hogy az ígéret-kinyeréshez elég-e, az
   mérés kérdése. Egy hívás leirata eldönti.
2. **A TranscripTonic webhook-beállításának pontos felülete** — a `simple` és az
   `advanced` body közti választás helye, és hogy ad-e egyedi fejlécet. Ha nem,
   a token az URL-be kerül.
3. **A `managedResources` marker-logikájának pontos alakja** a
   `extension-managed-resources.ts`-ben, mielőtt a `'project'` ág megíródik.
4. **A gmail `MAILBOX_CONTRACT` aktuális verziója és metódus-listája**, hogy a
   `consumes` deklaráció a valóságra hivatkozzon.


---

## 14. Kiegészítés: az MCP-híd a CRM-2-be került

A 12. fejezet eredetileg a CRM-3-hoz sorolta az MCP-szervert. Két tény miatt
került előre, és mindkettő a CRM-1 befejezése után derült ki:

**Az eszközök e nélkül senkihez nem jutnak el.** A `CLAUDE.md` „A három
képességi réteg" szakasza szerint egy CLI-provider csak az MCP-réteget kapja
meg, az extension-tools réteget nem — és ebben a telepítésben minden ügynök
`claude-cli`-n fut. A CRM-1 négy olvasó eszköze tehát ma egyetlen ügynökhöz
sem jut el. Egy fázison át halasztani annyi lenne, mint a CRM-3-ig üresen
tartani a felületet, amit a CRM-1 megépített.

**A híd időközben szabványosítottá vált.** A CRM-1 tervezésekor ez a gmail
mintegy hatszáz soros egyedi shimjének átvételét jelentette volna, és ez volt
a halasztás indoka. Azóta a minta három extensionben (`aisignal`, `docs`,
`video`) azonos: `src/mcp-bridge.mjs` bájtra egyezik mindenhol, az
`mcp/server.mjs` generikus és egyetlen eszközt sem nevez meg, és
`extensions/mcp-shim-parity.test.mjs` őrzi, hogy a másolatok ne csússzanak
szét. A munka két fájl másolása két konstans cseréjével.

Vagyis a halasztás indoka megszűnt, a halasztás ára viszont megmaradt volna.


---

## 15. Kiegészítés: két korrekció az ügynök-deklarációhoz

A CRM-3 tervezésekor a kód két állítást megcáfolt a 2. és az 5. fejezetből.
Mindkettő olyan, ami implementálva csendben nem működött volna.

**Az „Ügyfélkezelő" nem kaphat heartbeat-et.** A 2. fejezet
`heartbeatEnabled`-del hirdette az ügynök-deklarációt, mintha az autonóm
ébredés ott bekapcsolható lenne. Nem az:
`src/lib/server/storage-normalization.ts` **minden betöltéskor** `false`-ra
állítja CLI-provideres ügynöknél, és a `CLAUDE.md` meg is indokolja — egy
CLI-provider előfizetést éget, nem API-kulcsot, és egy flottányi autonóm
ébredés nem kapcsolódhat be mellékhatásként. Ebben a telepítésben minden
ügynök `claude-cli`-n fut, tehát a `true` deklaráció némán felülíródna.

A működő mechanizmus a **deklarált cron-ütemezés**, ami feladatot ad az
ügynöknek. Az `aisignal` mindkét ügynöke így áll, és a CRM is így fog.

**Az MCP-hozzárendelést a manifest nem tudja elvégezni.** Az
`ExtensionManagedAgentDeclaration` ismer `mcpServerIds` mezőt, de a szerver
azonosítója telepítéskor generálódik, tehát egy repóban álló deklaráció nem
tudja megnevezni. Az `aisignal` sem próbálja: az operátor rendeli hozzá a
Settings → MCP Servers alatt, és a telepítő kiírja a bemásolandó blokkot.

Ez nem kényelmi kérdés: a 14. fejezet szerint egy CLI-provider csak az
MCP-réteget kapja meg, tehát **az ügynök az MCP-hozzárendelésig némán semmit
nem tud csinálni** a CRM-mel. A telepítőnek ezt ki kell mondania, nem
opcionális lépésként.
