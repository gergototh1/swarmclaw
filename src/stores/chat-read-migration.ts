import { hmrSingleton } from '@/lib/shared-utils'
import { api } from '@/lib/app/api-client'

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

const migrationState = hmrSingleton('chatReadMigration_done', () => ({ done: false }))

/**
 * Egyszer fut le a folyamat eleteben. A `done` akkor is bebillen, ha a migracio
 * reszlegesen hasalt el -- a kulcs viszont OLYANKOR MEGMARAD, tehat a kovetkezo
 * INDITAS ujraprobalja. Igy egy betoltesen belul nem porog ujra, de egy elveszett
 * ertek sem ragad benn oroKre.
 */
export async function runChatReadMigrationOnce(): Promise<void> {
  if (migrationState.done) return
  migrationState.done = true
  if (typeof localStorage === 'undefined') return
  const raw = localStorage.getItem(LOCAL_READ_KEY)
  if (!raw) return
  let stored: Record<string, number>
  try {
    stored = JSON.parse(raw) as Record<string, number>
  } catch {
    localStorage.removeItem(LOCAL_READ_KEY)
    return
  }
  const ok = await migrateLocalReadTimestamps({
    read: () => stored,
    push: async (id) => { await api('POST', `/chats/${id}/read`) },
  })
  if (ok) localStorage.removeItem(LOCAL_READ_KEY)
}
