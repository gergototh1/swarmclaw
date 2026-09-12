/**
 * A CRM helye az URL-ben.
 *
 * A nézet és a nyitott ügyfél korábban `useState` volt: elnavigálás után a
 * lap lebomlott, és visszatérve a Ma nézet fogadott, bármi volt is nyitva.
 * Az URL-ben tartva az újratöltés, a könyvjelző és a fül is oda tér vissza.
 *
 *   ''                     -> Ma
 *   'ugyfelek'             -> ügyféllista
 *   'ugyfelek/<accountId>' -> ügyféllap
 *   'ugyek'                -> ügyek
 *
 * Minden más a Ma nézet: egy elírt vagy elavult link is működő lapra visz.
 */

export type Nezet = 'ma' | 'ugyfelek' | 'ugyek'

export type CrmHely =
  | { nezet: 'ma' }
  | { nezet: 'ugyfelek'; accountId: string | null }
  | { nezet: 'ugyek' }

export function helyAzUtbol(subPath: string): CrmHely {
  const [elso, masodik] = subPath.split('/').filter(Boolean)
  if (elso === 'ugyek') return { nezet: 'ugyek' }
  if (elso !== 'ugyfelek') return { nezet: 'ma' }
  if (!masodik) return { nezet: 'ugyfelek', accountId: null }
  try {
    return { nezet: 'ugyfelek', accountId: decodeURIComponent(masodik) }
  } catch {
    return { nezet: 'ugyfelek', accountId: null }
  }
}

export function utAHelybol(hely: CrmHely): string {
  if (hely.nezet === 'ugyek') return 'ugyek'
  if (hely.nezet === 'ugyfelek') {
    return hely.accountId ? `ugyfelek/${encodeURIComponent(hely.accountId)}` : 'ugyfelek'
  }
  return ''
}

/** Egy fül a nézete gyökerére visz: az Ügyfelek fül a listára, nem egy korábban nyitott lapra. */
export function alapHely(nezet: Nezet): CrmHely {
  return nezet === 'ugyfelek' ? { nezet, accountId: null } : { nezet }
}
