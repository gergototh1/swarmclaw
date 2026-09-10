import { isDelegatedSession } from '@/lib/conversation-list'
import type { Session, Sessions } from '@/types'

/**
 * Egy chat összes subagent-gyereke, legfrissebb elöl.
 *
 * Ez a biztonsági háló az inline sor mögött. Régi chatekben a swarm
 * tool-output már nincs a transzkriptben, és az `assign_to_agent` által
 * nyitott gyerekek sosem kapnak inline sort -- a `parentSessionId` viszont
 * tartós, és rá van írva mindegyikre, amit a `platform-mcp.ts` javítása ÓTA
 * indítottak.
 *
 * Az az előtt keletkezettekre nincs: a híd bedrótozott `sessionId: null`-lal
 * építette a tool-tömböt, így a régebbi subagent sessionök szülő nélkül
 * maradtak, és visszamenőleg nem pótolható. Azok csak az inline sorukból
 * érhetők el, ami a transzkriptből olvas. A háló tehát előre feszül, nem
 * hátra.
 *
 * A `sessionType` szűrő azért kell a szülő-egyezés MELLÉ, mert a
 * `buildNewAgentSessionPayload` (`new-session.ts`) a felhasználó saját
 * "új chat ebből" sessionjére is ráteszi a szülőt. Az nem subagent.
 */
export function listSubagentChildren(sessions: Sessions, parentSessionId: string): Session[] {
  return Object.values(sessions)
    .filter((s) => s.parentSessionId === parentSessionId && isDelegatedSession(s))
    .sort((a, b) => (b.lastActiveAt || 0) - (a.lastActiveAt || 0))
}

/**
 * Ugyanaz, de csak amelyik éppen fut.
 *
 * A fejléc alatti sáv ezt listázza: a felhasználó bármikor át akar látni a
 * futó munkán és bele akar nyúlni. Egy befejezett gyerek is elérhető marad
 * az inline soron át, ott van a helye -- ide az kerül, ami MOST dolgozik.
 */
export function listRunningSubagentChildren(sessions: Sessions, parentSessionId: string): Session[] {
  return listSubagentChildren(sessions, parentSessionId).filter((s) => s.active === true)
}
