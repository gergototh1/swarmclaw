/**
 * One queue per doc: the next read or save for a doc starts only after the
 * previous one for the same doc has settled.
 *
 * That is what lets the editor read its base version at the moment a save
 * starts and trust it. With two saves for one doc in flight at once, the second
 * could leave with a base the first was about to replace, and HTTP makes no
 * promise about which response comes back first -- which is how a reader's own
 * autosave used to come back as "changed in the meantime by someone else".
 * Loads go through the same queue, so a doc reopened while its last save is
 * still out is read after that save lands, not before.
 *
 * Different docs never wait for each other. A run that rejects does not block
 * the next run for its doc, and its caller still gets the rejection.
 *
 * Pure: no React, no DOM.
 */

export type SaveQueue = (docId: string, run: () => Promise<void>) => Promise<void>

export function createSaveQueue(): SaveQueue {
  const tails = new Map<string, Promise<void>>()

  return (docId, run) => {
    const previous = tails.get(docId) ?? Promise.resolve()
    const result = previous.then(run)
    // What the next run for this doc waits on: settled, never rejected.
    const tail = result.then(() => undefined, () => undefined)
    tails.set(docId, tail)
    void tail.then(() => {
      if (tails.get(docId) === tail) tails.delete(docId)
    })
    return result
  }
}
