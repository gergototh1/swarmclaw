/**
 * A `localStorage` `sc_last_read` kulcsanak egyszeri felkoltoztetese a szerverre.
 *
 * MIERT KELL EGYALTALAN. Az olvasottsag eddig kliens-oldalon elt. Ha csak
 * atallnank a szerver-oldali mezore, minden korabban olvasott chat egyszerre
 * olvasatlanra ugrana -- egy tele lista pirossal, amirol a felhasznalo tudja,
 * hogy hazugsag.
 *
 * HIBANAL NEM TORLUNK. A visszateresi ertek azt mondja meg, torolheto-e a
 * kulcs. Reszleges sikernel `false`: inkabb fusson meg egyszer a kovetkezo
 * betolteskor, mint hogy elvesszen.
 */
export const LOCAL_READ_KEY = 'sc_last_read'

export interface MigrateReadDeps {
  read: () => Record<string, number>
  push: (sessionId: string) => Promise<void>
}

export async function migrateLocalReadTimestamps(deps: MigrateReadDeps): Promise<boolean> {
  const stored = deps.read()
  const ids = Object.keys(stored)
  if (ids.length === 0) return true
  const results = await Promise.allSettled(ids.map((id) => deps.push(id)))
  return results.every((r) => r.status === 'fulfilled')
}
