# Célzott javítás kész render után

**Cél:** az operátor megnézi a kész videót, megmondja mi a baj — globálisan
vagy egy jelenetre —, és a modul **csak azt** javítja. Nem születik új terv az
egész videóra, nem indul újra a lektorálás, és nem fizetünk újra a
narrációért, ami nem változott.

---

## 1. Mit old meg, és mit nem

Az első éles futás után a videó ott áll `qa_ok` állapotban, és az operátor
látja rajta, hogy a harmadik jelenet címe rosszat állít, a hatodik pedig
későn jelenik meg. Ma ezzel nem tud kezdeni semmit. A visszajelzését el
tudja mondani — a `ext_video_visszajelzesek` tábla `jelenet` és `at_ms`
mezőt is tárol, a lapon ott az idővonal és az űrlap —, de a sor **elfekszik**:
egyetlen ügynök-tool sem adja oda a gyártónak. A `videoReviewMaterial`
összegyűjti ugyan, de a napi átnézéshez, tanulságírásra; nem ennek a videónak
a javítására. A `videoQueue` a bukott lektorálást és a render-hibát sorolja
fel — egy kész videó három operátori megjegyzéssel láthatatlan.

Az egyetlen mai út a `videoDraft`: új tervverzió az egész videóra, vissza
lektorálásra, majd narráció és render elölről. Az operátor szemszögéből ez
"kezdjük újra", holott egyetlen szót akart átíratni.

**Amit ez a spec megold:** a nyitott kérések eljutnak a gyártóhoz, a javítás
csak a megnevezett jeleneteket érinti, a render lektor nélkül indul, és a
kérés akkor zárul, amikor a javított render elkészült.

**Amit NEM old meg:** a publikálást, az ütemezést és a naptár-nézetet. Azok
külön projekt, külön speccel; a platform-engedélyek (YouTube-hitelesítés,
Meta app review, TikTok audit) naptári időt esznek, és párhuzamosan futnak
ezzel a munkával.

---

## 2. A modell

A kérés a meglévő `ext_video_visszajelzesek` sor. Két új oszlop adja neki az
életciklust:

    kezelte_render_id TEXT    -- melyik render zárta le; NULL amíg nyitott
    kezelt_at         TEXT    -- mikor

**Nyitott** az a sor, amelyre `kezelte_render_id IS NULL` és `forras = 'operator'`.
Az importált sorok (`forras = 'import'`, az analitikából) nem kérések: azok
megfigyelések, és nem zárulnak.

**Globális vagy jelenetre szóló** — ez már ma is a táblában van, csak senki nem
olvassa így: `jelenet IS NULL` a globális kérés, kitöltve az adott jelenetre
szóló. Az `at_ms` az idővonalra kattintással töltődik, és a jelenet melletti
pontosítás, nem külön tény.

**Melyik renderről szól** — a meglévő `render_id`. Egy kérés arról a renderről
szól, amit az operátor épp nézett; lezárni egy nála **későbbi** render tudja.

---

## 3. A folyamat

    1. az operátor megnézi a rendert, és ír egy vagy több kérést
       (a mai űrlap; jelenet és időpont opcionális)
    2. "Javítás kérése" gomb  ->  ügynök-forduló a Videó Gyártónak
    3. a gyártó elolvassa a nyitott kéréseket        (videoFixes)
    4. a gyártó beadja a célzott javítást            (videoRevise)
    5. narráció: csak a megváltozott mondatra
    6. render: lektor nélkül
    7. a render elkészül  ->  a bedolgozott kérések lezárulnak

A 2. lépés a Task 2-ben megépített megrendelő-mechanizmust használja
(`ui/megrendeles.ts`): session a `Videó Gyártó` ügynökkel, egy utasítás, nincs
streamelés. A lap nem várja meg a fordulót; a bizonyíték az, hogy megjelenik az
új verzió.

Miért ügynök, és nem közvetlen művelet: "írd át a címkét úgy, hogy határt
mondjon" ítélet. A modul mechanikus lépései (nyitás, narráció, render) a lapról
közvetlenül futnak; ez nem az.

---

## 4. `videoRevise` — a kapu, ami miatt ez működik

A gyártó megnevezi, mely jeleneteket írja át, és mely kéréseket dolgozza be:

    videoRevise({ videoId, jelenetek: [{ index, ...propok }], javitasIdk: [...] })

A modul a szülő verzióból indul ki, és **ellenőrzi, hogy minden más jelenet
bájtra azonos maradt**. Ha a gyártó hozzányúlt olyanhoz, amiről nem esett szó,
a beadás elutasul megnevezve (`erintetlen_jelenet_valtozott`), és a jelenet
indexét megnevezi.

Ez az, ami a "csak a kért dolgok javuljanak" ígéretet **kapuvá** teszi
ahelyett, hogy remény maradna. Egy modell, ami egy jelenet átírása közben
"menet közben javít" egy másikat, itt megáll.

A narrációra ugyanez áll: egy jelenet mondata csak akkor változhat, ha az a
jelenet a megnevezettek közt van.

**Verziósor keletkezik.** A modul csak tárolt tervből tud reprodukálható
rendert csinálni, és a QA-sor a fájl ujjlenyomatához kötődik — a verzió a
nyilvántartás, nem munkafolyamat. Amit az operátor nem lát: "vissza a startra".
A verzió `szarmazas` mezője `operator_javitas`, szemben az ügynök magától írt
`terv`-jével.

---

## 5. A render-kapu szűkítése

Ma `render.mjs` keményen tiltja a rendert érvényes lektori ítélet nélkül. Ez a
kapu fogta el az első éles futáson mindkét forrás nélküli állítást, és marad.

Amit a spec hozzátesz: egy `operator_javitas` származású verzió akkor is
renderelhető, ha rá magára nincs verdikt — feltéve, hogy a **szülő verzió**
átment. A jogosultság az operátoré: ő nevezte meg a változást és ő nézi meg az
eredményt.

Amit ügynök ír magától, arra a kapu változatlan. A napi automata nem tud ezen
az úton kimenni.

---

## 6. Amit a gyártó lát

`videoFixes({ videoId })` a nyitott kéréseket adja, jelenet szerint csoportosítva:

    { globalis: [{ id, szoveg, atMs, at }],
      jelenetenkent: { "3": [{ id, szoveg, atMs, at }], ... },
      renderId, tervId, tervVerzio }

A kérés szövege az operátoré — nem idegen szöveg, de nem is utasítás a
modulnak: a gyártó olvassa és dönt. A `videoQueue` új sora (`javitasVar`)
felsorolja azokat a videókat, amelyeknek van nyitott kérésük, hogy az ütemezett
futás is rájuk találjon.

---

## 7. A lezárás

Amikor a `videoRevise`-ból induló render `kesz` állapotba ér, a `javitasIdk`-ban
megnevezett sorok megkapják a `kezelte_render_id`-t. A lapon a kérés mellett
látszik, melyik render zárta.

Ha a javítás nem sikerült, az operátor **új** kérést ír. A régi nem nyílik újra:
egy lezárt kérésre egy render már megszületett, és a napló arról szól, mi
történt, nem arról, mi a jelenlegi vélemény.

---

## 8. Amit nem építünk

- **Nincs újranyitás.** Lásd fent.
- **Nincs részleges render.** A modul az egész videót rendereli újra; egyetlen
  jelenet újravágása a kit dolga lenne, és nincs rá kérés.
- **Nincs automatikus javítás.** A kérés mindig operátortól jön; a modul nem
  találja ki magától, mit kellene javítani.
- **Nincs `tempo`-illesztés.** A `lepes` illesztése külön munkában elkészült
  (`e5e3602`); a `tempo` egy másik mechanizmus, és nincs rá kérés.

---

## 9. Fájlok

- Módosít: `extensions/video/src/db.mjs` (két oszlop + migráció, olvasások)
- Módosít: `extensions/video/src/terv.mjs` (`videoFixes`, `videoRevise`, `videoQueue`)
- Módosít: `extensions/video/src/render.mjs` (a kapu szűkítése, a lezárás)
- Módosít: `extensions/video/src/rpc.mjs` (a lap javítás-kérése)
- Módosít: `extensions/video/ui/video.tsx`, `ui/api.ts`, `ui/style.css`
- Módosít: `extensions/video/skills/video-jelenetlista/SKILL.md`
- Tesztek: `test/db.test.mjs`, `test/terv.test.mjs`, `test/render.test.mjs`,
  `test/rpc.test.mjs`, `test/ui.test.mjs`
