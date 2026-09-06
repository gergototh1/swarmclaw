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
 *  - `javitas_lanc_hibas` -- a modul nem tudta bejárni a láncot: kör, a
 *    korlátnál hosszabb lánc, vagy egy `szulo_terv_id`, ami sehová nem mutat.
 *    Ez NEM ugyanaz, mint "a lánc végén nincs átment terv": ott egy lektori
 *    forduló megoldja a helyzetet, itt nem oldja meg semmi, amit egy ügynök
 *    tehet -- a sor maga romlott el. A kapott vázlatban ez a három eset a
 *    `szulo_verdikt_hianyzik` "előbb azt kell lektorálni" mondatára futott
 *    volna ki, ami olyan tettre küldi a hívót, ami nem segít.
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
  let jelen = terv
  for (let i = 0; i < JAVITAS_LANC_MAX && jelen; i += 1) {
    if (latott.has(jelen.id)) break
    latott.add(jelen.id)
    const verdikt = repo.passingVerdikt(jelen.id, jelen.terv_hash)
    if (verdikt) return { ok: true, verdiktId: verdikt.id, atmentTervId: jelen.id }
    if (jelen.szarmazas !== 'operator_javitas') {
      // Itt ért véget a lánc egy rendes tervnél, ami nem ment át. Hogy a
      // hívott terv MAGA volt-e ez, vagy egy őse, két különböző tény: az
      // elsőnél a hívó a saját beadását lektoráltatja, a másodiknál a lánc
      // alját. `i === 0` az egyetlen hely, ahol ez eldől.
      if (i > 0) return { ok: false, kod: 'szulo_verdikt_hianyzik', uzenet: 'ez operátori javítás, és a lánc alján álló terv az, amit a lektor nem engedett át; előbb azt kell lektorálni' }
      const masHash = repo.verdiktek(jelen.id).some((v) => v.verdikt === 'atmegy')
      return masHash
        ? { ok: false, kod: 'verdikt_elavult', uzenet: 'van atmegy verdikt erre a tervre, de más hash-sel; a lektornak újra kell néznie' }
        : { ok: false, kod: 'verdikt_hianyzik', uzenet: 'erre a tervre nincs atmegy verdikt' }
    }
    jelen = jelen.szulo_terv_id ? repo.terv(jelen.szulo_terv_id) : null
  }
  return { ok: false, kod: 'javitas_lanc_hibas', uzenet: 'a javítás-lánc nem járható be: kör van benne, hosszabb a megengedettnél, vagy egy szülő sor hiányzik; ezt nem lektorálás oldja meg' }
}
