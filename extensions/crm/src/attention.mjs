/**
 * Mi igényel figyelmet, és milyen sorrendben.
 *
 * TISZTA FÜGGVÉNY, ADATBÁZIS NÉLKÜL. A rangsor a rendszer hangja: ha rosszul
 * sorrendez, az ügynök a rossz dologról ír, és ez nem hibaüzenetként
 * jelentkezik — hanem úgy, hogy a figyelmeztetések néhány hét alatt
 * elveszítik a hitelüket. Egy táblázatos teszt ezt olcsón megfogja; egy
 * adatbázisra kötött nem.
 *
 * ITT SINCS MODELLHÍVÁS. A rangsor számolt: a típus adja a súlyt, a kor a
 * finomhangolást. Az ügynök ebből ÍR, nem ebből KÖVETKEZTET.
 */

/**
 * A négy típus súlya, romló sürgősség szerint.
 *
 * A saját ígéret vezet, mert az az egyetlen, ami a te szavadon múlik: a másik
 * három azt írja le, hogy valami nem történt meg, ez azt, hogy te mondtad,
 * hogy meg fog. Az idegen ígéret zár, mert azon nem te dolgozol — csak tudni
 * kell róla, mielőtt elévül.
 */
const SULY = Object.freeze({
  sajat_igeret: 0,
  valasz_nelkul: 1,
  nema_ugy: 2,
  idegen_igeret: 3,
})

/** Hány napja. Hiányzó időpont a végtelen múlt: az sosem történt meg. */
function korNapban(iso, most) {
  if (!iso) return Number.MAX_SAFE_INTEGER
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return Number.MAX_SAFE_INTEGER
  return Math.floor((Date.parse(most) - t) / 86400000)
}

const napSzoveg = (k) => (k === Number.MAX_SAFE_INTEGER ? 'még soha' : `${k} napja`)

export function rangsor({ silent = [], unanswered = [], oursOverdue = [], theirsOverdue = [] }, most) {
  const sorok = []

  for (const d of silent) {
    const kor = korNapban(d.last_event_at, most)
    sorok.push({
      kind: 'nema_ugy', accountId: d.account_id, dealId: d.deal_id, kor,
      cim: d.title,
      indok: d.last_event_at ? `${napSzoveg(kor)} nem történt semmi ezen a nyitott ügyön` : 'ezen a nyitott ügyön még soha nem történt semmi',
    })
  }

  for (const u of unanswered) {
    const kor = korNapban(u.occurred_at, most)
    sorok.push({
      kind: 'valasz_nelkul', accountId: u.account_id, eventId: u.event_id, kor,
      cim: u.subject || '(tárgy nélkül)',
      indok: `${napSzoveg(kor)} érkezett, és nem ment rá válasz`,
    })
  }

  for (const c of oursOverdue) {
    const kor = korNapban(c.created_at, most)
    sorok.push({
      kind: 'sajat_igeret', accountId: c.account_id, dealId: c.deal_id || null,
      commitmentId: c.id, eventId: c.event_id, kor,
      cim: c.text,
      indok: `${napSzoveg(kor)} ígérted, és nem lett belőle feladat`,
    })
  }

  for (const c of theirsOverdue) {
    const kor = korNapban(c.created_at, most)
    sorok.push({
      kind: 'idegen_igeret', accountId: c.account_id, dealId: c.deal_id || null,
      commitmentId: c.id, eventId: c.event_id, kor,
      cim: c.text,
      indok: `${napSzoveg(kor)} ígérték neked, és nem érkezett meg`,
    })
  }

  // Típus előbb, kor utána. Az `id` a döntetlent töri, hogy a sorrend két
  // egyforma futás közt ne mozogjon -- egy ingadozó lista olvashatatlan.
  return sorok.sort((a, b) =>
    SULY[a.kind] - SULY[b.kind]
    || b.kor - a.kor
    || String(a.commitmentId || a.dealId || a.eventId).localeCompare(String(b.commitmentId || b.dealId || b.eventId)))
}
