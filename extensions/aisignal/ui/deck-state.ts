import type { Decision, DecideResult, Item } from './api'
import { errorText, readDecideResult } from './api'

/**
 * The deck's state and every transition on it, with no React in sight.
 *
 * The deck is optimistic: a card leaves the screen the moment the operator
 * decides, and the write follows. What that must never become is a false
 * report, so every way the write can fail has its own transition here and
 * test/ui.test.mjs drives each one:
 *
 *   - the write threw: the card comes back to the front, the undo entry is
 *     dropped (there is nothing to undo), and the toast carries the message;
 *   - the write answered `ok: false`: the row was gone before the write ran.
 *     The card is not put back (it would be a card for a row that no longer
 *     exists) and the undo entry is dropped, and the toast says so;
 *   - an undo threw: the card is taken off the front again and its undo entry
 *     restored, because the row's stored status did not change.
 *
 * `decided` counts the decisions that have landed since the board was loaded,
 * so the "still undecided" number the deck shows can stay honest without a
 * round trip: `board.undecided` was true at load and each landed decision moves
 * it by one.
 */

export type DeckDecision = Exclude<Decision, 'undo'>

export interface UndoEntry {
  item: Item
  decision: DeckDecision
}

export interface DeckState {
  queue: Item[]
  undo: UndoEntry[]
  decided: number
  toast: string | null
}

/** How many decisions can be taken back, newest first. */
export const UNDO_DEPTH = 10

/** How far across its own width a card must be dragged before release decides it. */
export const DRAG_THRESHOLD = 0.25

export function initialDeck(deck: Item[]): DeckState {
  return { queue: deck, undo: [], decided: 0, toast: null }
}

/** The stamp a drag shows once, and only once, it is past the threshold. */
export function stampFor(ratio: number): DeckDecision | null {
  if (ratio > DRAG_THRESHOLD) return 'save'
  if (ratio < -DRAG_THRESHOLD) return 'archive'
  return null
}

/** The number still undecided, from the count at load and what has landed since. */
export function remainingUndecided(undecidedAtLoad: number, state: DeckState): number {
  return Math.max(0, undecidedAtLoad - state.decided)
}

export function beginDecision(state: DeckState, decision: DeckDecision): { state: DeckState; item: Item } | null {
  const item = state.queue[0]
  if (!item) return null
  return {
    item,
    state: {
      queue: state.queue.slice(1),
      undo: [{ item, decision }, ...state.undo].slice(0, UNDO_DEPTH),
      decided: state.decided + 1,
      toast: null,
    },
  }
}

export function failDecision(state: DeckState, item: Item, message: string): DeckState {
  return {
    queue: [item, ...state.queue.filter((q) => q.id !== item.id)],
    undo: state.undo.filter((u) => u.item.id !== item.id),
    decided: state.decided - 1,
    toast: `A döntés nem mentődött el: ${message}`,
  }
}

export function loseDecision(state: DeckState, item: Item): DeckState {
  return {
    queue: state.queue.filter((q) => q.id !== item.id),
    undo: state.undo.filter((u) => u.item.id !== item.id),
    decided: state.decided - 1,
    toast: 'Ez a kártya időközben eltűnt az adatbázisból, a döntés nem íródott le sehova.',
  }
}

export function beginUndo(state: DeckState): { state: DeckState; entry: UndoEntry } | null {
  const entry = state.undo[0]
  if (!entry) return null
  return {
    entry,
    state: {
      queue: [entry.item, ...state.queue],
      undo: state.undo.slice(1),
      decided: state.decided - 1,
      toast: null,
    },
  }
}

export function failUndo(state: DeckState, entry: UndoEntry, message: string): DeckState {
  return {
    queue: state.queue.filter((q) => q.id !== entry.item.id),
    undo: [entry, ...state.undo].slice(0, UNDO_DEPTH),
    decided: state.decided + 1,
    toast: `A visszavonás nem sikerült: ${message}`,
  }
}

export function loseUndo(state: DeckState, entry: UndoEntry): DeckState {
  return {
    queue: state.queue.filter((q) => q.id !== entry.item.id),
    undo: state.undo.filter((u) => u.item.id !== entry.item.id),
    decided: state.decided + 1,
    toast: 'Ez a kártya időközben eltűnt az adatbázisból, nincs mit visszavonni.',
  }
}

export function dismissToast(state: DeckState): DeckState {
  return state.toast === null ? state : { ...state, toast: null }
}

/** What the deck calls to write one decision; the page binds it to `rpc('decide')`. */
export type DecideFn = (id: string, decision: Decision) => Promise<unknown>

export interface DeckController {
  getState(): DeckState
  subscribe(listener: () => void): () => void
  /** Decide the top card. Resolves once the write has landed or been rolled back. */
  commit(decision: DeckDecision): Promise<void>
  /** Take back the newest decision. Resolves once the undo has landed or been rolled back. */
  undoLast(): Promise<void>
  dismissToast(): void
}

/**
 * The deck's store: the transitions above, driven by the write's outcome.
 *
 * A plain object with `subscribe`/`getState` so the component can attach with
 * `useSyncExternalStore` and the test can drive it with a fake `decide` and no
 * DOM. The two async methods resolve after the state has settled, so a test
 * awaits them and reads the result.
 */
export function createDeckController(deck: Item[], decide: DecideFn): DeckController {
  let state = initialDeck(deck)
  const listeners = new Set<() => void>()
  const set = (next: DeckState) => {
    state = next
    for (const listener of listeners) listener()
  }
  const outcome = async (id: string, decision: Decision): Promise<{ result: DecideResult } | { error: string }> => {
    try {
      return { result: readDecideResult(await decide(id, decision)) }
    } catch (err) {
      return { error: errorText(err) }
    }
  }
  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    async commit(decision) {
      const begun = beginDecision(state, decision)
      if (!begun) return
      set(begun.state)
      const landed = await outcome(begun.item.id, decision)
      if ('error' in landed) set(failDecision(state, begun.item, landed.error))
      else if (!landed.result.ok) set(loseDecision(state, begun.item))
    },
    async undoLast() {
      const begun = beginUndo(state)
      if (!begun) return
      set(begun.state)
      const landed = await outcome(begun.entry.item.id, 'undo')
      if ('error' in landed) set(failUndo(state, begun.entry, landed.error))
      else if (!landed.result.ok) set(loseUndo(state, begun.entry))
    },
    dismissToast() {
      set(dismissToast(state))
    },
  }
}

/** What a key press on the deck means, or null when it means nothing here. */
export type DeckKeyAction = 'archive' | 'save' | 'open' | 'undo'

/** The part of a keydown the deck reads; `KeyboardEvent` satisfies it. */
export interface DeckKeyEvent {
  key: string
  metaKey: boolean
  ctrlKey: boolean
  altKey: boolean
  target: unknown
}

/**
 * The deck's keys, and only when the key reaches the deck.
 *
 * The listener is on the window, so every key on the page passes through
 * here first, and a key that a control under focus would act on must be left
 * to it. Nothing fires while the operator is typing: an editable target (the
 * list's search box, or any input the host shell puts on the page) keeps its
 * own arrows and its own `u`. And nothing fires while a control is focused:
 * Enter on a button, a link or a details summary activates that control, and
 * the arrows on a tab move along the tablist. Before this rule the listener
 * took Enter from every button on the page and opened the top card's url
 * instead, and an arrow on the "Lista" tab decided a card. The deck's keys are
 * the body's and the card's, which nobody can tab to.
 */
export function deckKeyAction(event: DeckKeyEvent): DeckKeyAction | null {
  if (isControlTarget(event.target)) return null
  if (event.altKey) return null
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') return 'undo'
  if (event.metaKey || event.ctrlKey) return null
  switch (event.key) {
    case 'ArrowLeft': return 'archive'
    case 'ArrowRight': return 'save'
    case 'Enter': return 'open'
    case 'u': return 'undo'
    default: return null
  }
}

/**
 * Tags the keyboard can land on and act in, whatever else is known about the
 * element: the editable ones, and the ones a key activates or scrolls. Listed
 * by name rather than read from `tabIndex` alone because a test hands in a
 * bare `{ tagName }` and a browser may report a summary's or a link's
 * tabIndex differently; the `tabIndex` check below catches what the list
 * cannot name, such as a div the host made focusable or a `role="tab"`.
 */
const CONTROL_TAGS: readonly string[] = [
  'INPUT', 'TEXTAREA', 'SELECT', 'OPTION',
  'BUTTON', 'A', 'SUMMARY',
  'IFRAME', 'AUDIO', 'VIDEO',
]

function isControlTarget(target: unknown): boolean {
  if (typeof target !== 'object' || target === null) return false
  const el = target as { tagName?: unknown; isContentEditable?: unknown; tabIndex?: unknown }
  const tag = typeof el.tagName === 'string' ? el.tagName.toUpperCase() : ''
  if (CONTROL_TAGS.includes(tag)) return true
  if (el.isContentEditable === true) return true
  // The body and a plain element report -1; anything at 0 or above is in the
  // tab order and so is a control, whatever its tag.
  return typeof el.tabIndex === 'number' && el.tabIndex >= 0
}

/** What the deck does for each key; the component binds these to its controller. */
export interface DeckKeyHandlers {
  commit(decision: DeckDecision): void
  open(): void
  undo(): void
}

/**
 * The keydown listener the deck installs on the window while it is mounted.
 *
 * A key that is the deck's has its default prevented and its handler called;
 * any other key -- one that means nothing here, or one that reached a control
 * -- is left untouched, default and all, so the control it landed on still
 * gets it. Returns whether the key was taken, which is what the test reads.
 * Kept out of the component so the test can drive the very listener the deck
 * installs without a DOM to mount it in.
 */
export function deckKeyListener(handlers: DeckKeyHandlers): (event: DeckKeyEvent & { preventDefault(): void }) => boolean {
  return (event) => {
    const action = deckKeyAction(event)
    if (!action) return false
    event.preventDefault()
    if (action === 'archive') handlers.commit('archive')
    else if (action === 'save') handlers.commit('save')
    else if (action === 'open') handlers.open()
    else handlers.undo()
    return true
  }
}
