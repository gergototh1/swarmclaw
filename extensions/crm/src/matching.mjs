/**
 * Kihez tartozik ez a levél.
 *
 * TISZTA FÜGGVÉNY, ÉS EZ NEM STÍLUSKÉRDÉS. Ez a rendszer legkockázatosabb
 * logikája, mert a hibája nem látszik: egy rosszul besorolt levél működő
 * rendszernek néz ki, csak egy másik ügyfél idővonalára ír, és onnan a
 * másik ügyfél összefoglalójába. Adatbázis és hálózat nélkül minden ága
 * táblázatosan végigmérhető, és a teszt olvasásából kiderül, mit csinál.
 *
 * A hívó három keresőt ad be `lookups`-ként; ez a modul nem tud arról, hogy
 * mögöttük SQL van.
 *
 * ITT NINCS ÉS NEM IS LESZ MODELLHÍVÁS. (spec 1.2) Egy „szerintem ez a
 * Morvai Kft. lesz" tipp attól még rossz, hogy magabiztosan hangzik, és az
 * eredménye csendben rossz adat.
 */

/**
 * Domainek, amikre a 3. lépés soha nem tippel.
 *
 * Egy közösségi domain nem azonosít céget: a `gmail.com` mögött mindenki ott
 * van. Ha ezekre tippelnénk, az első ilyen ügyfél magához szippantaná az
 * összes többi magánemailt.
 */
export const SOCIAL_DOMAINS = new Set([
  'gmail.com', 'googlemail.com', 'freemail.hu', 'citromail.hu', 'indamail.hu',
  't-online.hu', 'vipmail.hu', 'outlook.com', 'hotmail.com', 'live.com',
  'yahoo.com', 'yahoo.co.uk', 'icloud.com', 'me.com', 'proton.me', 'protonmail.com',
  'upcmail.hu', 'gmx.com', 'gmx.net', 'mail.com',
])

const domainOf = (address) => {
  const at = String(address || '').lastIndexOf('@')
  return at < 0 ? '' : String(address).slice(at + 1).trim().toLowerCase()
}

/**
 * Egy domain akkor számít közösséginek, ha pontosan szerepel a
 * `SOCIAL_DOMAINS` listán, VAGY egy listás domain al-domainje (pl.
 * `mail.gmail.com` a `gmail.com` alá tartozik, mert utána a levélcím
 * ugyanúgy bárkié lehet). A pont a döntő a végén: enélkül `notgmail.com` is
 * egyezne a `gmail.com`-mal, pedig az csak véletlen szóvégi egyezés, nem
 * al-domain -- a `.` nélküli `endsWith` ezt a hibás találatot is beengedné.
 */
export function isSocialDomain(domain) {
  if (SOCIAL_DOMAINS.has(domain)) return true
  for (const social of SOCIAL_DOMAINS) {
    if (domain.endsWith(`.${social}`)) return true
  }
  return false
}

/**
 * Első találat nyer. A sorrend a spec 3.3-a, és a két „biztos" ág megelőzi a
 * „gyanú" ágat.
 */
export function matchMessage({ fromEmail, threadId }, lookups) {
  // 1. Pontos cím. A legerősebb jel: az operátor vette fel vagy erősítette meg.
  const contact = fromEmail ? lookups.contactByEmail(fromEmail) : null
  if (contact && contact.accountId) {
    return { kind: 'exact', accountId: contact.accountId, contactId: contact.id }
  }

  // 2. A szál. Ez fogja el a szál közbeni címváltást: ha ugyanabban a
  //    beszélgetésben már besoroltunk egy üzenetet, a folytatás oda tartozik,
  //    akkor is, ha a feladó közben magánemailre váltott.
  const threadAccount = threadId ? lookups.accountIdByThread(threadId) : null
  if (threadAccount) {
    return { kind: 'thread', accountId: threadAccount, contactId: contact ? contact.id : null }
  }

  // 3. Domain. Csak TIPP, és csak akkor, ha egyértelmű.
  const domain = domainOf(fromEmail)
  if (domain && !isSocialDomain(domain)) {
    const jeloltek = lookups.accountsByDomain(domain)
    // Két ügyfél ugyanazon a domainen nem tipp, hanem érme feldobás. Inkább
    // semmit, mint ötven százalékot.
    if (jeloltek.length === 1) return { kind: 'guess', guessAccountId: jeloltek[0] }
  }

  return { kind: 'none' }
}
