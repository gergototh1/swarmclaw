# Publikálás, ütemezés és naptár

**Cél:** a kész videó eljusson oda, ahol nézik — YouTube-ra, Facebookra,
Instagramra és TikTokra —, megírt szöveggel, átnézve, ütemezetten, és úgy,
hogy egy naptárban látod, mi ment ki és mi jön.

---

## 1. Mit old meg, és mit nem

Ma a lánc a QA-kapunál ér véget: van egy `qa_ok` videó, egy mp4 a lemezen, és
onnan az operátor kézzel viszi tovább. A modul tud mindent a fájlról — az
útját, az ujjlenyomatát, a hosszát, a narráció szövegét —, és semmit nem kezd
vele.

**Amit ez megold:** a kész videóból kiadás lesz; egy ügynök megírja mind a négy
platform szövegét, egy lektor átnézi, az operátor jóváhagyja, és a kiadás egy
sávba állva magától kimegy. A naptár mutatja, mi mikor megy, és mi lett belőle.

**Amit NEM old meg:** a videó szerkesztését (arra a célzott javítás van), a
teljesítmény visszamérését (a `ext_video_megtartas` importja már létezik és
külön ügy), és a nem-videó tartalmak publikálását — a modell megengedi, de ez
a spec csak videót visz ki.

---

## 2. Miért külön modul

`extensions/publish`, ami a `video.videos@1` szerződést fogyasztja. Négy érv,
súly szerint:

1. **A videó modul már most háromszor akkora, mint a következő legnagyobb**
   (13 008 sor kód + 12 441 teszt, szemben az aisignal 6 757-tel). A
   publikálás négy platform-klienst, OAuth-ot, ütemezőt, naptárat és
   fiókkezelést tesz hozzá. A mai átnézési körök minden egyes alkalommal
   valódi hibát találtak épp a már nagy fájlokban — ez tapasztalat, nem elv.
2. **A publikálás nem videó-specifikus.** Amit kiteszünk, az „egy kész fájl
   címmel és leírással"; egy doksi vagy egy kép ugyanez az alak. A videó
   modulba zárva örökre videó marad.
3. **A szerződés pont erre készült.** A `videos` docblockja szó szerint egy
   publishert nevez meg, ami egy `qa_ok` fájlt vesz fel, és a tizenegy oszlop
   pontosan azt adja: fájl, ujjlenyomat, hossz, cím, narráció-szöveg a
   leíráshoz, és a QA-átmenetel ideje. Ma egy fogyasztója van (Doksik); a
   második az, amit a spec 9.2 a mechanizmus valódi próbájának nevez.
4. **A váz ára ismert.** A CRM modul 3 683 sor kóddal teljes: lap, MCP-híd,
   ügynök, migrációk. Friss minta, nem régészet.

---

## 3. Az adatmodell

**`ext_publish_fiokok`** — egy összekötött fiók platformonként: melyik
platform, melyik külső fiók (id és megjelenítendő név), mikor kötötték össze,
és mit tud (lásd 6.).

**`ext_publish_kiadasok`** — egy videó, egy alkalom:

    id, video_id, allapot, sav_id, felulirt_idopont, letrehozva, ...

`allapot`: `vazlat` → `lektoralt` → `jovahagyva` → `utemezve` → `kesz`
(vagy `reszben` / `hiba`, lásd 5.).

**`ext_publish_agak`** — kiadásonként ÉS platformonként egy sor:

    id, kiadas_id, platform, szoveg (JSON), allapot, hiba_kod, url, kikuldve_at

Ez a döntés lényege: ha a TikTok elbukik és a YouTube átmegy, azt **egy
soron** látod, és **csak azt az ágat** kell újrapróbálni. A naptárban egy
bejegyzés van négy jelzővel, nem négy bejegyzés ugyanarról.

**`ext_publish_savok`** — mikor szoktak menni a posztok: nap és időpont.
A jóváhagyott kiadás a következő szabad sávba áll; `felulirt_idopont`
felülírja. A napt��r mindkettőt rajzolja, és megkülönbözteti őket.

---

## 4. A folyamat

    qa_ok videó (a videos szerződésen át)
        -> az író ügynök megírja a négy szöveget      -> vazlat
        -> a lektor átnézi                            -> lektoralt | vissza
        -> az operátor jóváhagyja                     -> jovahagyva
        -> a modul a következő szabad sávba teszi     -> utemezve
        -> az ütemezett futás kiteszi ágsoronként     -> kesz | reszben | hiba

**Az író és a lektor ugyanaz a felállás, ami a videó modulban ma is fogja a
forrás nélküli állításokat** — csak most egy KIMENŐ csatorna előtt, ahol egy
hibás mondat nem egy tervben marad, hanem nyilvánosan megjelenik.

A lektor a videó modul kódjaiból örököl, ahol illik (`allitas_forras_nelkul`),
és kap sajátokat arra, ami csak itt értelmes: hiányzó vagy kitalált hashtag,
a platform hosszkorlátját túllépő szöveg, olyan állítás a leírásban, ami a
videóban nem hangzik el.

---

## 5. Mi az, hogy „kész"

Négy ág, négy külön sors. A kiadás állapota ezekből következik, és **nem
mosható össze**:

- `kesz` — minden összekötött platform ága kiment
- `reszben` — legalább egy kiment, legalább egy nem
- `hiba` — egyik sem ment ki
- egy platform, aminek **nincs összekötött fiókja**, nem hiba: az ága
  `nincs_fiok` állapotban marad, és a kiadás nem várja meg

Egy elbukott ág újrapróbálható **önmagában**, a többihez nyúlás nélkül. Amit
egyszer kitettünk, azt nem tesszük ki újra: az ág az `url`-jét őrzi, és egy
már `kesz` ág újrapróbálása megnevezve elutasul.

---

## 6. Amit a platformok valósága ránk kényszerít

**YouTube.** Ráül a host meglévő Google OAuth-jára: a `ctx.oauth`
(`getGoogleAccessToken(purpose)`, `hasGoogleCredential(purpose)`, és a
külön tény, hogy be van-e egyáltalán állítva a Google-kliens) ma is élesben
szolgálja ki a Gmail modult. Új `purpose` a YouTube-scope-pal, és a
beleegyezés, a token tárolása meg a frissítése kész.

**A kvóta viszont kemény korlát, és a modulnak ELŐRE kell számolnia.** A
Google dokumentációja szerint egy feltöltés 1600 egység, a napi alapkeret
10 000 — nagyjából hat videó naponta. Ez a szám a dokumentációból van, nem
mérésből: az első éles feltöltésnél ellenőrizni kell, és a modul a saját
számlálójából utasít el megnevezve (`kvota_elfogyott`), MIELŐTT nekifut.
Egy kvótába futó feltöltés a videót is elveszítheti félúton.

**Meta (Facebook + Instagram).** Graph API, és **app review** kell a
publikáláshoz. Az Instagram ezen felül Business/Creator fiókot kér egy
Facebook-oldalhoz kötve.

**TikTok.** Content Posting API, és **audit** kell; audit nélkül az app csak
privátba vagy magának tud posztolni.

**Ezért mindhárom nem-YouTube adapter két dolgot tud, mielőtt bármit
küldene:** hogy van-e összekötött fiókja, és hogy az adott engedélye
igazolt-e. Amíg nincs, megnevezve utasít el — nem néma hiba, nem félig-siker.
És minden adapternek van **száraz futása**: minden lépés lefut a tényleges
kiposztolásig, a kérés összeáll és ellenőrizhető, de nem megy ki. Így a kód
kipróbálható, mielőtt az engedély megérkezik.

Ez a spec mind a négy platformot megépíti. Az operátor döntése volt, és a
kockázat ki van mondva: **három platform kódja hetekig nem próbálható
élesben**, és ebben a projektben a ki nem próbált kód minden egyes alkalommal
hibásnak bizonyult. A száraz futás és a megnevezett elutasítás az, ami ezt
láthatóvá teszi ahelyett, hogy csendben elrothadna.

---

## 7. Mi indítja el a kiküldést

A host ütemezései **ügynököt** indítanak, nem bővítmény-kódot
(`ExtensionManagedScheduleDeclaration`: `agentRef` + `taskPrompt`). Tehát a
kiküldést egy deklarált ütemezés hajtja, ami felébreszt egy ügynököt, az pedig
egyetlen toolt hív: „tedd ki, aminek eljött az ideje". Ugyanaz a minta, mint a
videó modul 07:15-ös gyártó futása.

**A sáv-alapú terv itt fizet:** mivel a kiküldés sávokban történik, az
ütemezésnek nem kell percenként futnia. A modul a beállított sáv-időpontokra
deklarál futást.

**A felülírt időpont ára ki van mondva:** egy sávon kívüli időpontra állított
kiadás a következő ütemezett futáskor megy ki, tehát legfeljebb a futások
sűrűségének megfelelő csúszással. A naptár ezt mutatja is — a felülírt
időpont mellett az, hogy mikor fog ténylegesen kimenni.

---

## 8. A naptár

A modul lapja. Heti nézet, sávokra osztva:

- kiadásonként **egy** bejegyzés, négy platform-jelzővel (kiment / vár /
  elbukott / nincs fiók)
- a `vazlat` és a `jovahagyva` láthatóan más — az egyik még döntésre vár
- a bejegyzés áthúzható másik sávba, amíg nem ment ki
- a szabad sávok láthatók: a naptár megmondja, hova fér még

A vázlat szövegei a bejegyzésre kattintva olvashatók és jóváhagyhatók.
Minden platform szövege az operátoré és az ügynöké — React text child, soha
nem HTML.

---

## 9. Amit nem építünk

- **Nincs saját OAuth-tároló.** A Google a host felületén megy; a másik három
  a host `credentials` tárolóját használja, nem egy negyediket.
- **Nincs újraírás publikálás után.** Ami kiment, az kiment; a javítás a
  platform saját felületén történik.
- **Nincs több fiók platformonként** ebben a specben. A modell megengedi (a
  fiók-sor kulcsa a platform és a külső id), de a felület egyet kezel.
- **Nincs teljesítmény-visszamérés.** A `ext_video_megtartas` importja
  létezik; összekötni külön ügy.
- **Nincs kép- vagy doksi-publikálás.** A modell megengedi, ez a spec nem.

---

## 10. Fájlok

Új modul a CRM mintájára:

- `extensions/publish/index.mjs`, `src/db.mjs`, `src/service.mjs`,
  `src/rpc.mjs`, `src/agents.mjs`, `src/mcp-bridge.mjs`, `mcp/server.mjs`
- platformonként egy adapter: `src/platform/youtube.mjs`, `facebook.mjs`,
  `instagram.mjs`, `tiktok.mjs` — mind ugyanaz a szűk felület
- `ui/` — naptár, kiadás-részletek, fiókok
- `scripts/install.mjs`, `scripts/build.mjs`
- `test/` — a testvérmodulok regisztere
- `package.json` `test:runtime`: az új suite glob-ja
