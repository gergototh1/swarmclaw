/**
 * What every editor this bundle mounts shares about the docs it saves.
 *
 * The Docs page and the panel beside the chat are two `Editor` instances from
 * the same bundle. When each kept these for itself, an edit flushed by a closing
 * panel was still out when the page opened the same doc: the page's read did
 * not wait for it, and the reader's next save came back as a conflict with
 * their own edit. One queue, one confirmed record and one generation count per
 * doc, for the whole bundle, close that.
 *
 * - `saveQueue`: reads and saves for one doc run one at a time (`save-queue.ts`).
 * - `confirmed`: the last version and body the server confirmed, per doc id.
 * - `generations`: bumped by "Keep theirs"; a save queued under an older
 *   generation does nothing when its turn comes.
 * - `failedEdits`: the latest save per doc that failed while that doc was not on
 *   screen, kept until the doc is opened again so the edit is not lost unseen.
 *
 * Pure: no React, no DOM.
 */

import type { Conflict } from './api'
import { createSaveQueue } from './save-queue'

export interface ConfirmedDoc {
  version: number
  content: string
}

export interface FailedEdit {
  /** The body the failed save sent. */
  mine: string
  /** The title, when the failed save was a rename. */
  title?: string
  /** Set when the server refused the save as a conflict. */
  conflict: Conflict | null
  /** Set when the save failed for any other reason. */
  message: string | null
}

export const saveQueue = createSaveQueue()

export const confirmed = new Map<string, ConfirmedDoc>()

export const generations = new Map<string, number>()

export const failedEdits = new Map<string, FailedEdit>()

export function generationOf(docId: string): number {
  return generations.get(docId) ?? 0
}

/** Voids every save for this doc queued before now; returns the new generation. */
export function bumpGeneration(docId: string): number {
  const next = generationOf(docId) + 1
  generations.set(docId, next)
  return next
}
