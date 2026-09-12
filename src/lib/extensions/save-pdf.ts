/**
 * "Save this HTML as a PDF", for extension pages.
 *
 * In the desktop app the main process prints it to a file and asks where to
 * put it (`electron/pdf-save.ts`). In a browser there is no such bridge, so
 * the system print dialog opens on a hidden frame and "Save as PDF" is one
 * choice in it. The caller learns which of the two happened.
 */
export interface SavePdfRequest {
  html: string
  fileName: string
}

export interface SavePdfResult {
  status: 'saved' | 'cancelled' | 'printed'
}

export interface DesktopPdfBridge {
  savePdf: (input: SavePdfRequest) => Promise<{ saved: boolean; path?: string; error?: string }>
}

export interface SavePdfDeps {
  desktop: DesktopPdfBridge | null
  printFallback: (html: string) => Promise<void>
}

function desktopBridge(): DesktopPdfBridge | null {
  const w = window as unknown as { swarmclawDesktop?: Partial<DesktopPdfBridge> }
  const bridge = w.swarmclawDesktop
  return bridge && typeof bridge.savePdf === 'function' ? (bridge as DesktopPdfBridge) : null
}

/** Prints the HTML from an off-screen frame, removed once printing is done. */
export function printHtmlInHiddenFrame(html: string): Promise<void> {
  return new Promise((resolve) => {
    const frame = document.createElement('iframe')
    frame.setAttribute('sandbox', 'allow-modals allow-same-origin')
    frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden'
    let done = false
    const finish = () => {
      if (done) return
      done = true
      frame.remove()
      resolve()
    }
    frame.onload = () => {
      const target = frame.contentWindow
      if (!target) { finish(); return }
      target.addEventListener('afterprint', finish)
      target.focus()
      target.print()
      setTimeout(finish, 60_000)
    }
    frame.srcdoc = html
    document.body.appendChild(frame)
  })
}

export async function savePdf(
  input: SavePdfRequest,
  deps: SavePdfDeps = { desktop: desktopBridge(), printFallback: printHtmlInHiddenFrame },
): Promise<SavePdfResult> {
  if (deps.desktop) {
    const result = await deps.desktop.savePdf(input)
    if (result.error) throw new Error(result.error)
    return { status: result.saved ? 'saved' : 'cancelled' }
  }
  await deps.printFallback(input.html)
  return { status: 'printed' }
}
