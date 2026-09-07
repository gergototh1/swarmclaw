/**
 * Van-e ennek a tervnek joga továbbmenni: narrációra, renderre, és javítás
 * alapjául.
 *
 * HÁROM HÍVÓJA VAN, ÉS EZÉRT VAN KÜLÖN FÁJLBAN. A `videoNarrate`, a render és
 * a `videoRevise` ugyanazt a kérdést teszi fel, és ha külön mondanák ki,
 * elcsúsznának: egy javítás, amit a narráció beenged és a render nem, egy
 * kifizetett hangfájl egy videóhoz, ami soha nem készül el. A modulok
 * egymást nem importálhatják (kör lenne), ahogy az `idozites.mjs` fejléce is
 * elmagyarázza a maga számaira. Ez a fájl semmit nem importál: a
 * repository-t a hívó adja át, tehát bármelyik modulból hívható.
 *
 * NEM DOB. A hívók elutasítási alakja különbözik, és egy dobás itt elvenné
 * tőlük a döntést.
 *
 * A SZABÁLY REKURZÍV, és ez a lényege. Egy operátori javításnak SOHA nincs
 * saját verdiktje -- épp ez a feature -- tehát a jog a szülőtől öröklődik,
 * és egy javítás javításánál a szülő maga is javítás. A lánc addig megy
 * vissza, amíg el nem ér az utolsó tervhez, amit egy lektor tényleg átengedett.
 * Enélkül a MÁSODIK javítási kör lehetetlen: az operátor megnézi a javított
 * rendert, ír egy új kérést (a spec 7. pontja szerint pontosan ezt teszi, ha
 * a javítás nem sikerült), és a modul azt mondaná, hogy a szülő nincs
 * lektorálva -- pedig a szülő épp az, amit ő maga kért.
 *
 * A séta korlátos. A `szulo_terv_id` mindig egy régebbi sorra mutat, tehát
 * kör elvben nem keletkezhet -- de egy kézzel írt vagy félig migrált sor
 * megteheti, és egy végtelen ciklus itt a hostot viszi el. A korlát a modul
 * saját száma, nem beállítás.
 *
 * NÉGY VÁLASZ, MERT NÉGY KÜLÖNBÖZŐ TÉNY VAN, ÉS MINDEGYIKRE MÁS A TEENDŐ.
 * A kapott vázlat hármat mondott ki, és a negyediket összemosta; itt a
 * szétválasztás, mert a hívó ezekből választja ki, mit mondjon az ügynöknek:
 *
 *  - `verdikt_hianyzik` / `verdikt_elavult` -- MAGÁRÓL a kapott tervről szól,
 *    és csak akkor, ha az nem javítás. Teendő: le kell lektorálni.
 *  - `szulo_verdikt_hianyzik` -- a kapott terv javítás, a lánc bejárható, és
 *    az alján álló rendes terv az, amit senki nem engedett át. Ez KÜLÖN kód,
 *    és nem a `verdikt_hianyzik`, mert egy javításról kimondani, hogy "erre a
 *    tervre nincs atmegy verdikt", igaz mondat ugyan, de félrevezető: egy
 *    javításnak sosem lesz saját verdiktje, tehát a hívó azt olvasná ki, hogy
 *    a saját beadását kell lektoráltatnia, holott a lánc alját kell.
 *  - `javitas_elbukott` -- a lánc egy olyan javításon áll, amit a lektor
 *    MEGNÉZETT és elbuktatott. `passingVerdikt` erre is üreset ad, ahogy egy
 *    meg nem ítélt javításra, de a két üres válasz két különböző tény: az
 *    egyik az, hogy javítást senki nem szokott ítélni (erre épül ez az egész
 *    öröklés), a másik az, hogy valaki ítélt, és nemet mondott. Csak a
 *    `szarmazas`-t nézve a séta a kettőn azonosan menne át, és egy elbuktatott
 *    javítás úgy örökölné a szülője átengedését, mintha meg sem ítélték volna
 *    -- ugyanaz a hiba-osztály, mint egy meg nem ítélt terv javítása, csak
 *    javítás-szülőn keresztül. A `videoVerdict`-nek nincs `szarmazas` kapuja,
 *    és egy javítás a beadása után a legfrissebb terv, tehát ez ma is
 *    megítélhető sor.
 *  - `javitas_lanc_hibas` -- a modul nem tudta bejárni a láncot: kör, vagy egy
 *    `szulo_terv_id`, ami sehová nem mutat. Ez NEM ugyanaz, mint "a lánc végén
 *    nincs átment terv": ott egy lektori forduló megoldja a helyzetet, itt nem
 *    oldja meg semmi, amit egy ügynök tehet -- a sor maga romlott el. A kapott
 *    vázlatban ez a `szulo_verdikt_hianyzik` "előbb azt kell lektorálni"
 *    mondatára futott volna ki, ami olyan tettre küldi a hívót, ami nem segít.
 *  - `javitas_lanc_tul_hosszu` -- a lánc ÉP, csak hosszabb, mint amennyit ez a
 *    séta visszakövet. Külön kód, és nem a `javitas_lanc_hibas`, mert itt nincs
 *    semmi elromolva és VAN teendő: egy `videoDraft` és egy lektori forduló új
 *    alapot ad. A két esetet egy néven kimondani azt üzenné az ügynöknek, hogy
 *    a helyzet reménytelen, amikor nem az.
 */

/** Ahány javítás-generációt visszasétálunk, mielőtt a láncot romlottnak mondjuk. */
export const JAVITAS_LANC_MAX = 50

/**
 * `{ ok: true, verdiktId, atmentTervId }`, ha a terv (vagy a javítás-láncán
 * feljebb egy őse) megkapta a lektor `atmegy` ítéletét a saját hash-ével;
 * különben `{ ok: false, kod, uzenet }`. Az `atmentTervId` azért van benne,
 * mert egy javításnál nem a kapott terv az, amit a lektor átengedett, és a
 * render sorába a verdikt id-je kerül.
 */
export function verdiktJog(repo, terv) {
  const latott = new Set()
  let kor = false
  let jelen = terv
  for (let i = 0; i < JAVITAS_LANC_MAX && jelen; i += 1) {
    if (latott.has(jelen.id)) { kor = true; break }
    latott.add(jelen.id)
    const verdikt = repo.passingVerdikt(jelen.id, jelen.terv_hash)
    if (verdikt) return { ok: true, verdiktId: verdikt.id, atmentTervId: jelen.id }
    if (jelen.szarmazas !== 'operator_javitas') {
      // Itt ért véget a lánc egy rendes tervnél, ami nem ment át. Hogy a
      // hívott terv MAGA volt-e ez, vagy egy őse, két különböző tény: az
      // elsőnél a hívó a saját beadását lektoráltatja, a másodiknál a lánc
      // alját. `i === 0` az egyetlen hely, ahol ez eldől.
      if (i > 0) return { ok: false, kod: 'szulo_verdikt_hianyzik', uzenet: 'ez operátori javítás, és a lánc alján álló terv az, amit a lektor nem engedett át; előbb azt kell lektorálni' }
      // A `verdikt_elavult` EGYETLEN valódi esete: a lektor átengedte, majd egy
      // későbbi ítélettel visszavonta (`passingVerdikt` a LEGFRISSEBB ítéletből
      // válaszol). A mondat korábban azt írta, hogy "van atmegy verdikt erre a
      // tervre, de más hash-sel" -- ez a helyzet nem áll elő: egy tervsor
      // `terv_hash`-e a beszúráskor íródik és nem változik, tehát egy másik
      // hash egy MÁSIK terv sora, és annak a verdiktjei ide be sem kerülnek. A
      // szöveg a `render.mjs`-ből öröklődött, és olyan tettre küldte az
      // ügynököt (keresd meg, melyik hash-hez van meg az ítélet), aminek nincs
      // tárgya. A név is ezt követi: nem a hash más, hanem volt már átengedés.
      const voltAtmegy = repo.verdiktek(jelen.id).some((v) => v.verdikt === 'atmegy')
      return voltAtmegy
        ? { ok: false, kod: 'verdikt_elavult', uzenet: 'volt atmegy verdikt ezen a terven, de egy későbbi ítélet visszavonta; új lektori ítélet kell rá, mielőtt továbbmehet' }
        : { ok: false, kod: 'verdikt_hianyzik', uzenet: 'erre a tervre nincs atmegy verdikt' }
    }
    // A LEKTOR NEMET MONDHATOTT ERRE A JAVÍTÁSRA IS. `passingVerdikt` a
    // legfrissebb ítéletet nézi, és üreset ad a soha meg nem ítélt javításra
    // és az elbuktatottra egyaránt -- csak a `szarmazas`-t nézve a séta a
    // kettőn azonosan menne tovább a szülőhöz, és az elbukott javítás úgy
    // örökölné a szülője átengedését, mintha meg sem ítélték volna. A
    // `verdiktek` növekvő sorrendben ad (`src/db.mjs`), tehát az utolsó elem a
    // legfrissebb ítélet; nincs szükség új repository-olvasóra.
    const utolsoItelet = repo.verdiktek(jelen.id).at(-1)
    if (utolsoItelet && utolsoItelet.verdikt === 'elbukik') {
      return { ok: false, kod: 'javitas_elbukott', uzenet: 'ezt a javítást a lektor elbuktatta, tehát nem viheti tovább a szülője átengedését; új ítélet kell rá, vagy a videoDraft-tal beadott új verzió' }
    }
    jelen = jelen.szulo_terv_id ? repo.terv(jelen.szulo_terv_id) : null
  }
  // Két kimenet, mert két teendő. A kör és a sehová sem mutató szülő romlott
  // sor; a korlátnál hosszabb, egyébként ép lánc nem az.
  if (kor || !jelen) return { ok: false, kod: 'javitas_lanc_hibas', uzenet: 'a javítás-lánc nem járható be: kör van benne, vagy egy szülő sor hiányzik; ezt nem lektorálás oldja meg' }
  return { ok: false, kod: 'javitas_lanc_tul_hosszu', uzenet: 'a javítás-lánc hosszabb, mint amennyit a modul visszakövet; a videoDraft-tal beadott új verzió és egy lektori forduló ad új alapot' }
}
