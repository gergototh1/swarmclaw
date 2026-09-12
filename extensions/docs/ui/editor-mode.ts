/**
 * Which view of a doc the viewer last chose: the formatted editor or the raw
 * markdown. A per-viewer convenience, so it lives in localStorage and a
 * storage that is missing or refuses (a private window, blocked site data)
 * simply means the default view -- never a broken page.
 */
export type EditorMode = 'formatted' | 'markdown'

const KEY = 'swarmclaw.docs.editorMode'

type ModeStorage = Pick<Storage, 'getItem' | 'setItem'>

function browserStorage(): ModeStorage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage
  } catch {
    return null
  }
}

export function readEditorMode(storage: ModeStorage | null = browserStorage()): EditorMode {
  try {
    return storage?.getItem(KEY) === 'markdown' ? 'markdown' : 'formatted'
  } catch {
    return 'formatted'
  }
}

export function writeEditorMode(mode: EditorMode, storage: ModeStorage | null = browserStorage()): void {
  try {
    storage?.setItem(KEY, mode)
  } catch {
    // The preference is lost for this viewer; the switch itself already happened.
  }
}
