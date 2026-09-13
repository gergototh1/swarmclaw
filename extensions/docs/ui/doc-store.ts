/**
 * What the editors this bundle mounts share about the docs they save, and the
 * helpers for what each editor keeps for itself.
 *
 * The Docs page and the panel beside the chat are two `Editor` instances from
 * the same bundle. Shared, for the whole bundle:
 *
 * - `saveQueue`: reads and saves for one doc run one at a time
 *   (`save-queue.ts`), whichever editor queued them. This is what makes a doc
 *   reopened right after a closing panel flushed its edit safe: the new
 *   editor's read waits in the same queue, so it reads after the flushed save
 *   has landed, with the edit and its version in it.
 * - `failedEdits`: the latest save per doc that failed while that doc was not
 *   on screen, or a bar still up when its editor left the doc, kept until the
 *   doc is opened again -- in whichever editor -- so the edit is not lost
 *   unseen.
 * - `saveFailureCount`: how many saves have failed so far, on screen or not,
 *   so a flush can tell whether the saves it waited on all landed.
 *
 * Kept PER EDITOR, not here:
 *
 * - The confirmed record (`ConfirmedDoc` per doc id): the last version and
 *   body that editor saw the server confirm. Each save's base version comes
 *   from it. Two editors open on one doc must each save on the version they
 *   themselves last saw; with one shared record, the second editor's save
 *   would take the first's version as its base and silently write over text
 *   it never showed, instead of getting a conflict.
 * - The generation count (`generationOf` / `bumpGeneration` over that editor's
 *   own map): bumped by that editor's "Keep theirs", so a save queued by that
 *   editor under an older generation does nothing when its turn comes. Another
 *   editor's saves are its own business.
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
  /**
   * The version the edit was made on: the base the failed save was sent with.
   * For a conflict bar kept when its editor left the doc, the version that
   * refused it. Compared on the next open only when `conflict` is null.
   */
  baseVersion: number
}

export const saveQueue = createSaveQueue()

export const failedEdits = new Map<string, FailedEdit>()

const failures = { count: 0 }

/** A save failed, on screen or off: counted so a flush can tell. */
export function noteSaveFailure(): void {
  failures.count += 1
}

export function saveFailureCount(): number {
  return failures.count
}

export function generationOf(generations: Map<string, number>, docId: string): number {
  return generations.get(docId) ?? 0
}

/** Voids every save for this doc queued before now under these generations; returns the new generation. */
export function bumpGeneration(generations: Map<string, number>, docId: string): number {
  const next = generationOf(generations, docId) + 1
  generations.set(docId, next)
  return next
}
