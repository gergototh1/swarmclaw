/**
 * Per-document save queue: makes two concurrent saves for the same document
 * impossible, so a save always reads its base version AFTER the previous
 * save for that same document has settled.
 *
 * WHY THIS REPLACES THE RETRY. Two saves for one document could previously be
 * in flight at once (an autosave debounce firing, then a Cmd+S, a flush on
 * document switch, or a rename racing either). Whichever conflict response
 * came back first was handled with a "was another save in flight?" guess and
 * a same-version retry -- a guess, because the guard that would make it safe
 * (the OTHER save's response already applied) is not something two
 * independent HTTP round-trips guarantee. Processed out of order, the retry
 * went out with a still-stale base, conflicted again, and on that second pass
 * either silently dropped the newer text or raised a false "someone else
 * edited this" bar for the caller's own save.
 *
 * Serializing removes the race instead of guessing about it: a save for a
 * document waits for the previous save for that SAME document to settle
 * (resolve OR reject) before it is even issued, and it reads the base version
 * only after that wait. By the time it reads, the previous response has
 * already written the version ref synchronously (see `ment` in
 * `szerkeszto.tsx`), so the base it reads is always fresh. With that
 * guarantee, a conflict on the still-open document can only be somebody
 * else's edit -- there is no self-inflicted case left to retry.
 *
 * Saves for DIFFERENT documents never wait on each other: the queue is keyed,
 * and each key gets its own independent chain.
 *
 * A rejected run must not jam its own key's queue: the next run for that key
 * still has to proceed. This module chains on a version of each run that
 * never rejects, while still returning the caller its own run's real
 * rejection.
 *
 * Pure: no React, no DOM. The component holds one instance of this in a ref.
 */

export type Sorba = (kulcs: string, futas: () => Promise<void>) => Promise<void>

export function letrehozMentesSor(): Sorba {
  const farkak = new Map<string, Promise<void>>()

  return function sorba(kulcs, futas) {
    const elozoFarok = farkak.get(kulcs) ?? Promise.resolve()
    // A predecessor's rejection must not propagate into this run's start --
    // it only needs to have settled, not succeeded.
    const varakozas = elozoFarok.then(
      () => undefined,
      () => undefined,
    )
    const sajatFutas = varakozas.then(futas)
    // The chain stored for the NEXT run on this key must also never reject,
    // for the same reason. The caller still gets `sajatFutas`, which carries
    // the real outcome.
    const csendesFarok = sajatFutas.then(
      () => undefined,
      () => undefined,
    )
    farkak.set(kulcs, csendesFarok)
    // Housekeeping only: once this is the last thing queued for the key and
    // it has settled, drop the entry so the map does not grow forever.
    csendesFarok.then(() => {
      if (farkak.get(kulcs) === csendesFarok) farkak.delete(kulcs)
    })
    return sajatFutas
  }
}
