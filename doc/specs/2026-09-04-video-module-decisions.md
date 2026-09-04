# Videómodul: rögzített döntések

Ez nem a specifikáció, hanem az, ami a specifikáció megírása előtt már el van
döntve. Az operátor válaszai, és a hozzájuk tartozó indok.

## A modul alakja

A SwarmClaw **vezérlőréteg**, nem render-motor. A Remotion ott marad, ahol a
projekt van (`~/DEV/marketing/ai-use-cases/`, saját git, saját remote).

Kényszer, ami ezt amúgy is eldönti: a Remotion Chrome Headless Shellt igényel,
az extension viszont nem hozhat natív modult, és Electronban is, VPS-en is
ugyanúgy kell futnia.

## A határ a SwarmClaw és a Remotion között

Négy dolog megy át, semmi más:

| Irány | Tartalom |
|---|---|
| Remotion → SwarmClaw | a generált sablon-katalógus (`katalogus.generated.json`): milyen jelenettípusok vannak, mit várnak |
| SwarmClaw → Remotion | a jelenetlista JSON-ként |
| SwarmClaw → Remotion | egy render-parancs |
| Remotion → SwarmClaw | a kész fájl útvonala és a mérések |

A SwarmClaw **soha nem ír `.tsx`-et**. A `FosVideo.tsx` (46 sor) már ma ezt az
ajtót nyitja: a jelenetlistát input propként veszi. A projekt saját
megfogalmazása: "a videó JSON-dokumentum, nem forrásfájl".

**Következmény, amit ki kell mondani:** a mai munkamód — videónként kézzel írt
`.tsx` kompozíció, ahogy a `remo` dolgozik — így nem jön át. Ha egy videóhoz
olyan kell, ami a kitben nincs, akkor a kit kap új sablont, a Remotion-repóban,
külön munkaként. Ez szűkítés, de ez hajtja a minőségi célt: minden új igény a
közös készletet gyarapítja, és a sablon-eredményesség csak így mérhető.

Az ügynök ettől **szerkezetileg** dolgozik a meglévő sablonokból: csak a
katalógusban létező jelenettípust tud kiadni. Nem utasítás, hanem kényszer.

## Állapot

A SwarmClaw saját `ext_video_` tábláiban. Nem a Studio SQLite-jában: a Studio
kódja szándékosan nem ír abba egyidejűleg, mert két író `SQLITE_BUSY`-t és
elveszett írásokat okoz, és VPS-en a fájl nincs is ott.

## Ügynökök

Kettő. Egy gyárt, egy támadja (`lektor`), a render **előtt**. Indok: a gyártó
ügynök a saját munkáját nézi át, és ez rendszeresen elnéző. A marveenben ez a
szerep létezik és él.

A mérhető hibákat továbbra is **program** fogja meg, nem ügynök és nem ember.
A `qa_gate.py` fejlécében rögzített eset: 2026-08-06-án két tétel 36 perccel a
renderelés előtt ért jóváhagyásra, és 5 másodperces néma klipként ment ki.
"Egy QA-lépés, amit ember pipál ki, olyan QA-lépés, amit vakon pipálnak ki."
A küszöbök (25-130 mp, 1080x1920, >=24 fps, 80% hangfedettség, -50 dB) egy-egy
valódi hibából származnak, és tartalom-ujjlenyomat érvényteleníti egy újrarender
után.

## Narráció (TTS)

Saját extension, **globális**: szerződést kínál a kódnak (a render-lánc is kér
hangot, nem csak az ügynök), és MCP-szervert az ügynököknek (bármelyik ügynök
elérje, konfigurációból, modulhoz kötés nélkül).

Ez egyben az extension-közti szerződés második fogyasztója. Egy platformképesség,
amit senki nem használ, bizonyítatlan képesség.

Tudni való: a Soniox-egyenleg elfogyott, és a felmérés szerint egyetlen repóban
sincs narráció-generáló szkript. A meglévő 404 mp3 másolható, újat készíteni
csak a beépítés megírása után lehet.

## Memória: hogyan lesznek egyre jobbak a videók

Az operátor kérése: napi cron, ami az adott ügynökkel átnézi a beszélgetéseket,
és a visszatérő hibákból javítja az ügynököket és a skilleket.

**Kikötés, ami nem az operátortól jön, hanem ehhez a döntéshez tartozik:** az
ügynök **javaslatot** ír, nem magát írja át. Egy rossz tanulság, amit senki nem
hagyott jóvá, ugyanúgy állandósul, mint egy jó. A marveenben van precedens arra,
hogy egy hook menet közben skillt ír -- ezt itt jóváhagyás mögé kell tenni.

Nyitott, a specifikációban eldöntendő: a videó-visszajelzésekből (időkódos,
jelenet-szintű) lesz-e gépi ellenőrzés a render előtt, és vezet-e minden sablon
saját eredményességet. Az operátor erre nem választott opciót, hanem a fenti
cront kérte helyette; a kettő nem zárja ki egymást.
