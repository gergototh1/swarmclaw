/**
 * The Docs editor's save logic, out of the React component so it can be
 * tested. The component (`editor.tsx`) keeps the refs, effects and rendering,
 * implements `DocScreen` over them, and calls in here for every load, save and
 * bar button.
 *
 * NOTHING TYPED IS DROPPED, AND NOTHING LANDS IN THE WRONG DOC. Each rule below
 * closes a way an edit used to go missing:
 *
 * - Leaving a doc -- another doc opens, the editor unmounts, the page is
 *   hidden, `flushAllEditors` runs -- saves the unsaved edit, whether or not
 *   its autosave countdown is still waiting: after a save failed on screen,
 *   none is. A conflict or not-saved bar still up when the editor moves to
 *   another doc or unmounts is kept in `failedEdits`, so the next open offers
 *   it again.
 * - Reads and saves for one doc run one at a time (`save-queue.ts`), and a
 *   save reads its base version when it starts. The last confirmed version and
 *   body are kept per doc id, so a save for a doc the reader has already left
 *   still uses, and still records, that doc's own version.
 * - A response only touches what is on screen while its doc is still the open
 *   one.
 * - Nothing is saved until the open doc has loaded: until then the editor is
 *   still showing the previous doc's text.
 * - The queue is shared by every editor this bundle mounts (`doc-store.ts`), so
 *   the Docs page and the chat panel wait for each other's saves on the same
 *   doc. The confirmed record and the generation count are this editor's own:
 *   two editors open on one doc each save on the version they last saw, so the
 *   second one to save gets a conflict instead of writing over the first.
 * - The conflict bar belongs to one doc: it goes away when another doc opens,
 *   and its buttons act only while that doc is open and loaded.
 * - "Keep theirs" voids every save this editor queued for the doc before the
 *   click, and applies theirs through the queue, after whatever is already
 *   out. A conflict that came back without their text reads the doc instead.
 *   The doc counts as not loaded from the click until that run finishes, so
 *   an edit typed during the wait (an autosave tick, a Cmd+S) cannot queue
 *   behind the run and land on top of theirs once it is applied.
 * - An edit typed while a delete is out is still marked dirty, so a failed
 *   delete saves it. The delete goes through the doc's queue, after any save
 *   already out for it; once it succeeds, nothing more is saved into that doc
 *   and its `failedEdits` entry goes.
 * - A save that fails while its doc is not on screen is kept, and shown the
 *   next time that doc opens -- by any editor, not just the one that failed.
 *   A later save that merely succeeds does not clear it: only the load that
 *   shows it, the bar's own buttons, or the doc's delete take it out of
 *   `failedEdits`. It comes back as a conflict when the doc has moved on from
 *   the version the edit was made on, so "Restore it" never writes over a
 *   version the reader was not shown.
 *
 * Pure: no React, no DOM. The shared queue, `failedEdits` and the failure
 * count come from `doc-store.ts`; everything on screen goes through `DocScreen`.
 */

import type { Conflict, Doc, Rpc } from './api'
import { errorText, isConflict, readDoc } from './api'
import {
  bumpGeneration,
  failedEdits,
  generationOf,
  noteSaveFailure,
  saveFailureCount,
  saveQueue,
  type ConfirmedDoc,
  type FailedEdit,
} from './doc-store'
import { shouldSaveOnModeSwitch } from './editor-dirty'
import type { SaveQueue } from './save-queue'

export type SaveState =
  | { kind: 'idle' }
  | { kind: 'saving' }
  | { kind: 'saved'; at: number }
  | { kind: 'error'; message: string }
  /**
   * `title` is set when the refused save was a rename, so "Keep mine" sends it
   * again. `restored` is set when the conflict came from a save made while the
   * doc was not on screen: the editor then shows the doc as loaded, not `mine`.
   */
  | { kind: 'conflict'; docId: string; conflict: Conflict; mine: string; title?: string; restored?: boolean }
  /**
   * A save made while the doc was not on screen failed for a reason other than
   * a conflict, on the version that is still current (`baseVersion`).
   */
  | { kind: 'unsaved'; docId: string; mine: string; message: string; title?: string; baseVersion: number }

const IDLE: SaveState = { kind: 'idle' }

/**
 * What the saver reads and writes on the editor that owns it. Getters are
 * asked at the moment they are needed, never cached, because a response can
 * land after the reader has moved on.
 */
export interface DocScreen {
  /** The doc the editor is showing or about to show (its `id` prop), null when none. */
  openId(): string | null
  /** The doc whose content is in the editor; null until the open doc has loaded. */
  loadedId(): string | null
  setLoadedId(docId: string | null): void
  /** Whether this doc's trash button was pressed and its delete has not settled. */
  isDeleteBlocked(docId: string): boolean
  setDeleteBlocked(docId: string | null): void
  /** Disables (true) or re-enables (false) the trash button for this doc. */
  showDeleting(docId: string, deleting: boolean): void
  /** The markdown on screen, saved or not. */
  currentMd(): string
  /** What the server last confirmed, as far as the screen knows. */
  savedMd(): string
  setSavedMd(md: string): void
  /** Whether the reader edited since the doc loaded or was last saved on screen. */
  isDirty(): boolean
  setDirty(dirty: boolean): void
  /** The bar or status shown now, as last set. */
  saveState(): SaveState
  setSaveState(next: SaveState | ((prev: SaveState) => SaveState)): void
  setVersion(version: number): void
  /** The stored title of the doc on screen, null when no doc is shown. */
  docTitle(): string | null
  /** The doc as read, or null for none; also reports its title to the page. */
  setDoc(doc: Doc | null): void
  /** A rename landed: the stored title changes, and is reported to the page. */
  setDocTitle(title: string): void
  /** The title field the reader types into. */
  setTitleField(title: string): void
  /** The markdown textarea's text. */
  setRawText(md: string): void
  /** The formatted editor's content, from markdown. */
  setEditorContent(md: string): void
  setLoadError(message: string | null): void
  cancelAutosave(): void
  scheduleAutosave(): void
  /** A save landed, on screen or not: the page refreshes what depends on it. */
  onSaved(): void
}

/**
 * How much of the screen a caller needs before it may act on a doc:
 * - `open`: the doc is the open one, loaded or not.
 * - `loaded`: open, and its content is in the editor.
 * - `unblocked`: loaded, and no delete of it is out.
 */
export type ScreenNeed = 'open' | 'loaded' | 'unblocked'

export interface SaveOptions {
  /** A rename: sent with the body as confirmed when the save starts. */
  title?: string
  /** Save on this version rather than the confirmed one ("Keep mine"). */
  baseVersion?: number
  /**
   * Send nothing when the body is already what this editor last saw confirmed:
   * a save of the same text may still have been out when this one was asked
   * for, and a second copy would only write another version.
   */
  unlessConfirmed?: boolean
}

export interface DocSaver {
  /** Whether the screen shows `docId` far enough for `need` (default `unblocked`). */
  canSave(docId: string | null, need?: ScreenNeed): docId is string
  /**
   * Opens `docId` (null: no doc): clears the previous doc's state, then reads
   * it through the queue. `showContent` puts the loaded markdown in the
   * formatted editor; null while there is no editor yet, when nothing is read.
   * Returns the cleanup that makes a late read do nothing.
   */
  open(docId: string | null, showContent: ((md: string) => void) | null): () => void
  /** The reader typed into `docId`. */
  edited(docId: string | null): void
  /** Queues a save of `md` for `docId`; `md` null is a rename (needs `opts.title`). */
  save(docId: string, md: string | null, opts?: SaveOptions): Promise<void>
  /** Cmd+S. */
  saveNow(docId: string | null): Promise<void>
  /** The title field was left with `typed` in it. */
  rename(docId: string | null, typed: string): Promise<void>
  /** The view is about to switch: saves an edit first, returns the markdown to carry across. */
  leaveView(docId: string | null): string
  keepMine(state: SaveState): Promise<void>
  keepTheirs(state: SaveState): Promise<void>
  restoreUnsaved(state: SaveState): void
  discardUnsaved(state: SaveState): void
  /** The trash button. `onDelete` resolves true when the doc is gone. */
  remove(docId: string | null, onDelete: () => Promise<boolean>): Promise<void>
  /** Pagehide and `flushAllEditors`: saves the unsaved edit to `docId` now. */
  flush(docId: string | null): void
  /** The editor moves off `docId`: keeps a bar still up, then saves the unsaved edit. */
  leave(docId: string | null): void
  /** Whether a conflict or not-saved bar for `docId` is up. */
  hasBar(docId: string): boolean
}

/**
 * The bar for an edit that failed while its doc was not on screen, against the
 * doc as just loaded -- what the server holds now, not what it held when the
 * save failed.
 *
 * A refused save is a conflict. So is any other failure once the doc has moved
 * on from the version the edit was made on: "Restore it" saves on the version
 * just loaded, and would silently erase a newer one the reader was never
 * shown. Only a failure on the version still current is a plain "not saved"
 * bar.
 */
export function stateForFailedEdit(docId: string, failed: FailedEdit, current: ConfirmedDoc): SaveState {
  if (failed.conflict || failed.baseVersion !== current.version) {
    const refusal: Conflict = failed.conflict ?? {
      error: 'conflict',
      message: failed.message ?? 'The save failed.',
      currentVersion: current.version,
      modifiedBy: null,
      theirs: current.content,
    }
    return {
      kind: 'conflict',
      docId,
      conflict: { ...refusal, currentVersion: current.version, theirs: current.content },
      mine: failed.mine,
      title: failed.title,
      restored: true,
    }
  }
  return {
    kind: 'unsaved',
    docId,
    mine: failed.mine,
    message: failed.message ?? 'The save failed.',
    title: failed.title,
    baseVersion: failed.baseVersion,
  }
}

/**
 * What "Open in Docs" says when kept failed edits stop it: each doc by the
 * title its failed save carried, or by its id when it carried none. Null when
 * nothing is kept.
 */
export function leaveBlockedMessage(edits: ReadonlyMap<string, FailedEdit> = failedEdits): string | null {
  const names = [...edits].map(([docId, edit]) => (edit.title ? `"${edit.title}"` : docId))
  if (names.length === 0) return null
  if (names.length === 1) return `An edit to ${names[0]} could not be saved, so Docs was not opened.`
  return `Edits to ${names.slice(0, -1).join(', ')} and ${names[names.length - 1]} could not be saved, so Docs was not opened.`
}

/** A mounted editor, as `flushAllEditors` sees it. */
export interface MountedEditor {
  /** Saves the editor's unsaved edit now. */
  flush(): void
  /** Whether the editor shows a conflict or not-saved bar the reader has not resolved. */
  hasBar(): boolean
  /** The queue its saves go through. */
  queue: SaveQueue
}

const mountedEditors = new Set<MountedEditor>()

/** Registers a mounted editor for `flushAllEditors`; returns the unregister. */
export function trackMountedEditor(entry: MountedEditor): () => void {
  mountedEditors.add(entry)
  return () => { mountedEditors.delete(entry) }
}

/**
 * Saves every pending edit in every mounted editor now, and resolves once every
 * read and save out at that moment has settled. For a link that leaves the page
 * with a full load, where the `pagehide` flush may be cut off.
 *
 * Resolves true only when every save it waited on landed: false when one of
 * them failed (on screen, where its editor shows the bar or the error, or off
 * screen), when any doc still has an edit in `failedEdits`, or when a mounted
 * editor still shows a conflict or not-saved bar -- that edit is not saved
 * either. All of it lives in module memory, which a page load wipes, so a
 * caller must not leave on false.
 */
export async function flushAllEditors(): Promise<boolean> {
  const failuresBefore = saveFailureCount()
  const queues = new Set<SaveQueue>([saveQueue])
  for (const entry of mountedEditors) {
    entry.flush()
    queues.add(entry.queue)
  }
  await Promise.all([...queues].map((queue) => queue.whenIdle()))
  const barUp = [...mountedEditors].some((entry) => entry.hasBar())
  return saveFailureCount() === failuresBefore && failedEdits.size === 0 && !barUp
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export function createDocSaver({ rpc, queue, screen }: { rpc: Rpc; queue: SaveQueue; screen: DocScreen }): DocSaver {
  /**
   * The last version and body this editor saw the server confirm, per doc id.
   * This editor's own, never shared: see `doc-store.ts` for why.
   */
  const confirmed = new Map<string, ConfirmedDoc>()
  /** Per doc id, bumped by this editor's "Keep theirs" to void its own queued saves. */
  const generations = new Map<string, number>()
  /** Docs this editor deleted: nothing more is saved into them until one loads again. */
  const trashed = new Set<string>()

  const canSave = (docId: string | null, need: ScreenNeed = 'unblocked'): docId is string => {
    if (docId === null || screen.openId() !== docId) return false
    if (need === 'open') return true
    if (screen.loadedId() !== docId) return false
    return need === 'loaded' || !screen.isDeleteBlocked(docId)
  }

  const open = (docId: string | null, showContent: ((md: string) => void) | null): (() => void) => {
    screen.setLoadedId(null)
    // The previous doc's bar, conflict included, must not stay up over this one.
    screen.setSaveState(IDLE)
    if (docId === null || !screen.isDeleteBlocked(docId)) screen.setDeleteBlocked(null)
    if (docId === null || showContent === null) {
      screen.setDoc(null)
      return () => {}
    }
    let stale = false
    screen.setLoadError(null)
    // The read waits behind any save still out for the same doc, so a doc
    // reopened mid-save is read with that save already in it.
    void queue(docId, async () => {
      try {
        const loaded = readDoc(await rpc('read', { id: docId }))
        if (stale) return
        const current = { version: loaded.version, content: loaded.content }
        confirmed.set(docId, current)
        trashed.delete(docId)
        screen.setDoc(loaded)
        screen.setVersion(loaded.version)
        screen.setTitleField(loaded.title)
        screen.setSavedMd(loaded.content)
        screen.setRawText(loaded.content)
        showContent(loaded.content)
        screen.setDirty(false)
        const failed = failedEdits.get(docId)
        failedEdits.delete(docId)
        screen.setSaveState(failed ? stateForFailedEdit(docId, failed, current) : IDLE)
        screen.setLoadedId(docId)
      } catch (err) {
        if (stale) return
        // A doc that cannot be read must not leave the previous doc's text on
        // screen under this doc's URL.
        screen.setDoc(null)
        screen.setVersion(0)
        screen.setTitleField('')
        screen.setSavedMd('')
        screen.setRawText('')
        showContent('')
        screen.setDirty(false)
        screen.setSaveState(IDLE)
        screen.setLoadError(messageOf(err))
      }
    })
    return () => { stale = true }
  }

  /**
   * Every save goes through here: the body, a rename, Cmd+S, a flush, a view
   * switch and "Keep mine". It is queued per doc and reads that doc's base
   * version when it starts. `md` null means a rename: it sends the body as
   * confirmed when the rename starts, so it cannot undo a body save queued
   * ahead of it.
   *
   * The doc's generation is taken when `save` is called: if "Keep theirs" has
   * bumped it by the time the run starts, the run does nothing, and a response
   * that lands after the bump touches nothing on screen. A conflict or an error
   * for a doc that is not on screen is kept in `failedEdits` for its next open.
   */
  const save = (docId: string, md: string | null, opts: SaveOptions = {}): Promise<void> => {
    const generation = generationOf(generations, docId)
    return queue(docId, async () => {
      const current = () => generationOf(generations, docId) === generation
      if (!current() || screen.isDeleteBlocked(docId) || trashed.has(docId)) return
      const content = md ?? confirmed.get(docId)?.content
      if (content === undefined) return
      if (opts.unlessConfirmed && confirmed.get(docId)?.content === content) return
      // Loaded, not merely open: a doc reopened while this save was out is read
      // after it, and that load would wipe a bar put up before it.
      const onScreen = () => canSave(docId)
      const baseVersion = opts.baseVersion ?? confirmed.get(docId)?.version ?? 0
      const fail = (conflict: Conflict | null, message: string | null) => {
        if (!current()) return
        noteSaveFailure()
        if (!onScreen()) {
          failedEdits.set(docId, { mine: content, title: opts.title, conflict, message, baseVersion })
          return
        }
        if (conflict) screen.setSaveState({ kind: 'conflict', docId, conflict, mine: content, title: opts.title })
        else screen.setSaveState({ kind: 'error', message: message ?? 'The save failed.' })
      }
      if (onScreen()) screen.setSaveState({ kind: 'saving' })
      try {
        const raw = await rpc('save', opts.title === undefined
          ? { id: docId, content, baseVersion }
          : { id: docId, content, title: opts.title, baseVersion })
        if (isConflict(raw)) {
          fail(raw, null)
          return
        }
        const message = errorText(raw)
        if (message) {
          fail(null, message)
          return
        }
        const next = (raw as { version?: number }).version
        confirmed.set(docId, { version: typeof next === 'number' ? next : baseVersion, content })
        screen.onSaved()
        if (!onScreen() || !current()) return
        if (typeof next === 'number') screen.setVersion(next)
        screen.setSavedMd(content)
        // Text typed while this save was out is still unsaved.
        if (screen.currentMd() === content) screen.setDirty(false)
        if (opts.title !== undefined) screen.setDocTitle(opts.title)
        screen.setSaveState({ kind: 'saved', at: Date.now() })
      } catch (err) {
        fail(null, messageOf(err))
      }
    })
  }

  /** An edit is dirty even while a delete is out; only the countdown waits for it. */
  const edited = (docId: string | null): void => {
    if (!canSave(docId, 'loaded')) return
    // Dirty even while a delete is out: if the delete fails, this is saved.
    screen.setDirty(true)
    if (!canSave(docId)) return
    screen.scheduleAutosave()
  }

  const saveNow = (docId: string | null): Promise<void> => {
    if (!canSave(docId)) return Promise.resolve()
    screen.cancelAutosave()
    return save(docId, screen.currentMd())
  }

  /**
   * A title is stored in the document's own front matter, so a rename is a
   * save. It is sent when the field is left rather than on every keystroke: a
   * rename writes a version, and one per letter would bury the real history.
   */
  const rename = (docId: string | null, typed: string): Promise<void> => {
    if (!canSave(docId, 'loaded')) return Promise.resolve()
    const trimmed = typed.trim()
    const stored = screen.docTitle()
    if (trimmed === '' || trimmed === stored) {
      screen.setTitleField(stored ?? '')
      return Promise.resolve()
    }
    return save(docId, null, { title: trimmed })
  }

  /**
   * Switching views carries the text across and saves what is pending first:
   * a change typed a moment ago in one view must not be lost to the other
   * view's copy.
   */
  const leaveView = (docId: string | null): string => {
    screen.cancelAutosave()
    const md = screen.currentMd()
    if (canSave(docId, 'loaded') && shouldSaveOnModeSwitch(screen.isDirty(), md, screen.savedMd())) void save(docId, md)
    return md
  }

  const keepMine = (state: SaveState): Promise<void> => {
    if (state.kind !== 'conflict' || !canSave(state.docId, 'loaded')) return Promise.resolve()
    const { docId, mine, title, conflict, restored } = state
    if (restored) {
      // This bar came from `failedEdits`; the load that showed it already
      // took the entry, but take it again in case a newer failure has not
      // landed here yet -- resolving this bar must not leave one behind.
      failedEdits.delete(docId)
      // The editor shows the doc as loaded, not the kept text: put it there.
      screen.cancelAutosave()
      screen.setRawText(mine)
      screen.setEditorContent(mine)
      screen.setDirty(true)
      if (title !== undefined) screen.setTitleField(title)
    }
    return save(docId, mine, { baseVersion: conflict.currentVersion, title })
  }

  /**
   * Every save this editor queued for the doc before the click is void from
   * here on, and theirs is applied in the queue, after whatever is already out.
   * The newest text the server is known to hold wins over an older conflict's.
   *
   * A conflict can come back without their text. Then the doc is read in the
   * queue and what the read returns is applied, as a load would -- an empty
   * body in its place would be shown, and saved by the next rename.
   *
   * The doc counts as not loaded from the click until this run finishes,
   * applying theirs or giving up: the loaded id is cleared below and every
   * save path (autosave, Cmd+S, the raw textarea) already refuses to run
   * while the doc has not loaded. Without this, an edit typed during the wait
   * -- an autosave tick or a Cmd+S -- would queue behind this run under the
   * new generation, land on top of theirs once it is applied, and go out as a
   * "saved" write the server never showed on screen.
   */
  const keepTheirs = (state: SaveState): Promise<void> => {
    if (state.kind !== 'conflict' || !canSave(state.docId, 'loaded')) return Promise.resolve()
    const { docId, conflict, title: refusedTitle, restored } = state
    screen.cancelAutosave()
    const generation = bumpGeneration(generations, docId)
    screen.setLoadedId(null)
    if (restored) failedEdits.delete(docId)
    const titleBefore = screen.docTitle() ?? ''
    screen.setSaveState(IDLE)
    return queue(docId, async () => {
      const current = () => generationOf(generations, docId) === generation
      // Whether this doc is still the one on screen. Not whether it is
      // "loaded" -- this run itself holds the loaded id at null until it
      // restores it below, so that check would never be true here.
      const onScreen = () => canSave(docId, 'open')
      if (!current()) return
      const known = confirmed.get(docId)
      let theirs: ConfirmedDoc
      let theirTitle = refusedTitle === undefined ? undefined : titleBefore
      if (known && known.version > conflict.currentVersion) {
        theirs = known
      } else if (conflict.theirs !== null) {
        theirs = { version: conflict.currentVersion, content: conflict.theirs }
      } else {
        try {
          const loaded = readDoc(await rpc('read', { id: docId }))
          if (!current()) return
          theirs = { version: loaded.version, content: loaded.content }
          theirTitle = loaded.title
          if (onScreen()) screen.setDoc(loaded)
        } catch (err) {
          if (current() && onScreen()) {
            // Restore before showing the error, or the reader is left unable
            // to save this doc at all.
            screen.setLoadedId(docId)
            screen.setSaveState({ kind: 'error', message: `Could not read their version: ${messageOf(err)}` })
          }
          return
        }
      }
      confirmed.set(docId, theirs)
      if (!onScreen()) return
      screen.setSavedMd(theirs.content)
      screen.setRawText(theirs.content)
      screen.setVersion(theirs.version)
      screen.setEditorContent(theirs.content)
      screen.setDirty(false)
      if (theirTitle !== undefined) screen.setTitleField(theirTitle)
      screen.setLoadedId(docId)
      screen.setSaveState(IDLE)
    })
  }

  const restoreUnsaved = (state: SaveState): void => {
    if (state.kind !== 'unsaved' || !canSave(state.docId, 'loaded')) return
    const { docId, mine } = state
    // This bar only ever comes from `failedEdits`; the load that showed it
    // already took the entry, but take it again in case a newer failure has
    // not landed here yet -- resolving this bar must not leave one behind.
    failedEdits.delete(docId)
    screen.setRawText(mine)
    screen.setEditorContent(mine)
    screen.setDirty(true)
    screen.setSaveState(IDLE)
    if (canSave(docId)) screen.scheduleAutosave()
  }

  const discardUnsaved = (state: SaveState): void => {
    if (state.kind !== 'unsaved' || !canSave(state.docId, 'loaded')) return
    failedEdits.delete(state.docId)
    screen.setSaveState(IDLE)
  }

  /**
   * The trash button. While the delete is out, this doc takes no saves and the
   * button takes no second click. If the doc turns out not to be gone, saving
   * comes back on and the screen is brought back in line with what the server
   * confirmed meanwhile: a save that was out when the button was pressed
   * landed without touching the screen. Then any text that differs from the
   * saved text is scheduled, whether it was typed before the click or after.
   *
   * The delete runs in the doc's queue, after any save already out for it, so
   * none of those lands in the trash or leaves a failed edit for a doc that is
   * gone. What follows it runs in the same step, so a save queued meanwhile --
   * by leaving the doc -- starts only once saving is back on, or the doc is
   * known to be gone and the save does nothing.
   */
  const remove = async (docId: string | null, onDelete: () => Promise<boolean>): Promise<void> => {
    if (docId === null || screen.isDeleteBlocked(docId)) return
    screen.setDeleteBlocked(docId)
    screen.cancelAutosave()
    screen.showDeleting(docId, true)
    await queue(docId, async () => {
      let gone = false
      try {
        gone = await onDelete()
      } catch {
        gone = false
      }
      screen.showDeleting(docId, false)
      if (gone) {
        trashed.add(docId)
        failedEdits.delete(docId)
        return
      }
      if (!screen.isDeleteBlocked(docId)) return
      screen.setDeleteBlocked(null)
      if (!canSave(docId, 'loaded')) return
      const known = confirmed.get(docId)
      if (known) {
        screen.setVersion(known.version)
        if (!screen.isDirty()) screen.setSavedMd(known.content)
      }
      screen.setSaveState((state) => (state.kind === 'saving' ? IDLE : state))
      if (screen.currentMd() !== screen.savedMd()) screen.scheduleAutosave()
    })
  }

  /** The conflict or not-saved bar up for `docId`, while the screen shows that doc loaded. */
  const barFor = (docId: string): Extract<SaveState, { kind: 'conflict' | 'unsaved' }> | null => {
    if (!canSave(docId, 'loaded')) return null
    const state = screen.saveState()
    return (state.kind === 'conflict' || state.kind === 'unsaved') && state.docId === docId ? state : null
  }

  /** The text on screen for `docId` that the reader edited and the server has not confirmed. */
  const unsavedEdit = (docId: string): string | null => {
    if (!canSave(docId, 'loaded') || !screen.isDirty()) return null
    const md = screen.currentMd()
    return md === screen.savedMd() ? null : md
  }

  /**
   * Saves the unsaved edit to `docId` now, whether or not its countdown is
   * still waiting: after a save failed on screen, none is. Not while a conflict
   * bar from a save made on screen is up -- the edit would be refused again on
   * the same base, and the bar is what holds it.
   */
  const flush = (docId: string | null): void => {
    screen.cancelAutosave()
    if (docId === null) return
    const md = unsavedEdit(docId)
    if (md === null) return
    const bar = barFor(docId)
    if (bar?.kind === 'conflict' && !bar.restored) return
    void save(docId, md, { unlessConfirmed: true })
  }

  /**
   * The editor moves off `docId`: another doc opens, or it unmounts. A bar
   * still up is kept in `failedEdits` first, so the next open offers it again
   * instead of the edit going away with the screen. For a conflict from a save
   * made on screen, the edit kept is the text on screen, which carries whatever
   * was typed after the refusal. Then the unsaved edit is saved; its failure,
   * now off screen, is kept by the rule in `save`.
   */
  const leave = (docId: string | null): void => {
    const bar = docId === null ? null : barFor(docId)
    if (docId !== null && bar?.kind === 'conflict') {
      const mine = bar.restored ? bar.mine : unsavedEdit(docId) ?? bar.mine
      failedEdits.set(docId, { mine, title: bar.title, conflict: bar.conflict, message: null, baseVersion: bar.conflict.currentVersion })
    } else if (docId !== null && bar?.kind === 'unsaved') {
      failedEdits.set(docId, { mine: bar.mine, title: bar.title, conflict: null, message: bar.message, baseVersion: bar.baseVersion })
    }
    flush(docId)
  }

  const hasBar = (docId: string): boolean => barFor(docId) !== null

  return {
    canSave,
    open,
    edited,
    save,
    saveNow,
    rename,
    leaveView,
    keepMine,
    keepTheirs,
    restoreUnsaved,
    discardUnsaved,
    remove,
    flush,
    leave,
    hasBar,
  }
}
