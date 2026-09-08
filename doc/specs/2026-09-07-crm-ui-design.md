# CRM felület — vizuális újratervezés

**Állapot:** jóváhagyva (látványterv: `claude.ai/code/artifact/64cfad52-84bf-46e3-a8a8-1fe76196cf5d`)
**Dátum:** 2026-09-07
**Előzmény:** CRM-1/2/3 (`doc/specs/2026-09-06-crm-extension-design.md`)

## 1. Mit csinálunk és mit nem

A CRM extension négy képernyője (Ma, Ügyfelek, Ügyfél lap, Ügyek) működik, de nyersen
néz ki: 15 sor CSS, natív elemek, semmilyen tipográfiai vagy térköz-rendszer. A
testvér extensionök ugyanezt 186–477 sorban oldják meg, kialakult mintával —
prefixelt osztályok, a hoszt téma-tokenjeiből olvasott színek fallbackkel. A CRM
ebből semmit nem használ.

**Ez a munka vizuális.** Az operátor megerősítette: az információs szerkezet jó, a
három fül és a szakaszok sorrendje a helyén van.

| Nem változik | Változik |
| --- | --- |
| A három fül és a köztük lévő navigáció | Tipográfia, térköz, hierarchia |
| A szakaszok sorrendje minden lapon | A jelölés (markup) szerkezete a szakaszokon belül |
| Minden rpc-hívás, argumentum és hibakezelés | Az állapot vizuális kódolása (csík, pill, hangsúly) |
| Melyik adat honnan jön | Az ügyfél lap egy oszlopból két hasábra bomlik |
| **A rangsorolás a szerveré** — a lap nem rendez újra | — |

Az utolsó sor nem stílus-kérdés. A figyelem-lista sorrendjét a `src/attention.mjs`
`rangsor`-a adja, és az Ügyfélkezelő ügynök a 08:10-es körében ugyanabból dolgozik.
Ha a lap más sorrendet mutatna, a napi üzenet ellenőrizhetetlen lenne — az operátor
nem tudná összevetni, amit olvas, azzal, amit lát.

## 2. A token-szerződés

A színek, betűk és sarok-lekerekítések **a hoszt tokenjeiből** jönnek, mindig
fallbackkel:

```css
color: var(--color-text, #e2e2ec);
background: var(--color-surface, #14141f);
border-radius: var(--radius, .625rem);
font-family: var(--font-sans, system-ui, sans-serif);
```

A fallback nem díszítés: ha a hoszt átnevez egy tokent, a lap olvasható marad
ahelyett, hogy átlátszó szövegre esne. Ez a `video` extension bevált mintája
(`extensions/video/ui/style.css` fejléce mondja ki ugyanezt).

**A betűket NEM töltjük be.** A hoszt már betöltötte őket, és deklarálja
`--font-sans`, `--font-display`, `--font-mono` néven. Az extension ezeket olvassa;
egy saját `@font-face` vagy Google Fonts `<link>` a bundle-ben hibás lenne. (A
jóváhagyott látványterv azért tölt be betűket, mert önálló lap — az éles CSS nem.)

Felhasznált tokenek:

- felületek: `--color-bg`, `--color-raised`, `--color-surface`, `--color-surface-2`, `--color-surface-3`
- szöveg: `--color-text`, `--color-text-2`, `--color-text-3`
- jelentés: `--color-accent`, `--color-success`, `--color-danger`, `--color-warning`
- keret: `--color-border`, `--color-border-hi`
- forma: `--radius`, `--radius-sm`, `--radius-xl`

A `--status-*` család (`--status-running-fg`, `--status-error-bg`, …) létezik a
hoszton, de **nem használjuk**: a jelentései (fut / hiba / tétlen) nem esnek egybe a
CRM trigger-típusaival, és egy „néma ügy" `--status-idle`-ként megjelenítve olyan
egyenértékűséget állítana, ami nem igaz. A négy trigger a saját jelentés-tokenjeit
kapja.

**Minden osztály `crm-` prefixet visel.** A hoszt a lapot a saját dokumentumába
injektálja; egy prefix nélküli szabály a shellt is átstílusozná.

## 3. Az állapot formában is látszik

Ez a redesign egyetlen tartalmi állítása. Ma mind a négy figyelem-trigger ugyanaz a
szürke szöveg, pedig nem egyenrangúak: az „én ígértem" a te elmaradásod, a „néma
ügy" csak csend. A `rangsor` súlyai (`SULY`, `src/attention.mjs`) ezt már tudják —
a felület nem mutatja.

| Trigger | Pill | Csík |
| --- | --- | --- |
| `sajat_igeret` — én ígértem | `--color-danger` | `--color-danger` |
| `valasz_nelkul` — válasz nélkül | `--color-warning` | `--color-warning` |
| `nema_ugy` — néma ügy | `--color-accent` | `--color-accent` |
| `idegen_igeret` — nekem ígérték | `--color-text-2` | `--color-text-3` |

A sorrend a szerveré marad; a szín csak **megnevezi**, amit a rangsor már eldöntött.
A színek sorrendje szándékosan egyezik a `SULY` sorrendjével, hogy a kettő ne
csúszhasson szét némán.

**Egy elsődleges művelet szakaszonként.** Az „Elfogad" kitöltött (`--color-accent`
alapon), az „Elvet" halk keret. Ma mindkettő ugyanaz a natív gomb: a feladatot
létrehozó és az elvető egyformán néz ki.

## 4. Képernyőnként

### 4.1 Ma

Sorrend változatlan: söprés-sáv → postafiók-állapot → Figyelmet igényel → Javaslatok
→ Besorolatlan.

- **Söprés-sáv:** egy sávban a gomb, a legutóbbi söprés számai monospace-ben
  (`--font-mono`, `tabular-nums`), és a postafiók-állapot. A `recordedOut` /
  `skippedOut` számok maradnak.
- **Figyelem-lista:** soronként bal csík (3px), pill, cím, kor (monospace), indok,
  „Megnyit". A `osszes > sorok.length` esetén a „lista teteje látszik" mondat marad —
  enélkül húsz sor és a teljes lista megkülönböztethetetlen.
- **Javaslatok:** kártyák rácsban (`minmax(310px, 1fr)`), bal oldali akcent-csíkkal.
  Az „Elfogadás…" közbeni tiltott állapot marad.
- **Besorolatlan:** soronként a feladó (monospace) és a tárgy balra, a találgatás-pill
  és a választó jobbra.

### 4.2 Ügyfelek

Szűrő + felvevő egy eszköztárban. A lista soronként: név, domainek (monospace),
státusz-pill. A sor egésze kattintható.

### 4.3 Ügyfél lap

**Két hasáb** (`1.35fr 1fr`, 860px alatt egy oszlop):

- **bal — amit olvasol:** összefoglaló (elavultság-jelzéssel, `--color-warning` bal
  csíkkal), idővonal
- **jobb — amit ellenőrzöl:** nyitott ígéretek, feladatok, ügyek, kapcsolatok

Az idővonal függőleges sínt kap: csomópont + vonal, a csomópont kerete jelöli az
irányt (bejövő / kimenő / jegyzet). A „Teljes szöveg" és a „Korábbiak" marad.

**Az idegen szöveg továbbra is szövegcsomópontként kerül a JSX-be**, soha nem
`dangerouslySetInnerHTML`-lel, és minden tárolt szöveget tartó doboz
`overflow-wrap: anywhere`-t kap: egy 4000 karakteres szó semmit nem tolhat le a
képernyőről.

### 4.4 Ügyek

A négy szakasz-oszlop fejlécet kap (név + darabszám + szakasz-csík), a kártyák
címet, ügyfelet, értéket (monospace, `tabular-nums`) és a műveleteket. A „Tovább"
az utolsó szakaszon továbbra sem jelenik meg. A futó megbízások listája alatta marad.

## 5. Kockázat: a meglévő UI-tesztek a jelölés alakját rögzítik

`test/ui.test.mjs`, `ma.test.mjs`, `ugyfel-lap.test.mjs` és `ugyek.test.mjs` a
**buildelt bundle szövegére** illesztenek, például:

```js
/onClick:\s*\(\)\s*=>\s*elfogad\(s\.id\),\s*disabled:/
/\.useEffect\)\(feladatokatTolt,\s*\[accountId\]\)/
```

A CRM-3 review ezeket úgy fogadta el, hogy megölik a mutációikat, de kimondta:
törékenyek a jelölés átrendezésére. Ez a munka pontosan azt csinálja.

**Szabály:** ha egy ilyen teszt elbukik, az alapértelmezett feltevés az, hogy **a
kód romlott el, nem a teszt**. A tesztet csak akkor írjuk át, ha a bukás oka
bizonyítottan a jelölés alakja, nem a bekötés — és az átírt teszt ugyanazt a
bekötést kell hogy őrizze (ugyanaz a mutáció bukjon rá). A tesztet gyengíteni,
hogy átmenjen, tilos.

Ahol a jelölés átrendezése amúgy is átírja a tesztet, ott érdemesebb a bekötést
**kiemelt tiszta függvényen** keresztül tesztelni (ahogy a `kovetkezoSzakasz` és a
`ugyfelFeladatai` már teszi), mint egy új reguláris kifejezést a bundle-re illeszteni.

## 6. Hozzáférhetőség

- Minden interaktív elem kap látható `:focus-visible` állapotot.
- A fülsáv `role="tablist"`-et, a fülek `role="tab"`-ot és `aria-selected`-et
  viselnek. Ma három sima gomb `aria-pressed`-del: az önmagában nem hibás, de a
  fülsáv-szerkezethez az `aria-selected` a helyes, és a kettőt keverni nem szabad.
  Egyik tesztet sem érinti (`grep aria-pressed test/` üres), csak a `main.tsx`-et és
  a stíluslapot.
- A jelentést **soha nem csak szín hordozza**: minden pill szöveges címkét is visel,
  minden csík mellett ott a pill.
- `prefers-reduced-motion` esetén nincs átmenet.
- A hiba- és állapotsávok `role="alert"` / `role="status"` szerepe marad.

## 7. Készültségi feltétel

1. Mind a négy képernyő a hoszt tokenjeiből öltözik, világos és sötét témában
   egyaránt olvasható.
2. A bundle nem tartalmaz betűtípus-betöltést és nem tartalmaz prefix nélküli
   CSS-szabályt.
3. Minden meglévő teszt zöld, vagy az 5. szakasz szabálya szerint, bizonyítottan
   átírva.
4. A lint baseline 345 marad.
5. Élő hoszton megnézve mind a négy képernyő — ez a felület, itt a képernyőkép a
   bizonyíték, nem a unit teszt.
