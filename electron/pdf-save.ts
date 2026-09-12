import { app, BrowserWindow, dialog } from 'electron'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { readSavePdfInput, safePdfFileName } from './pdf-export'

export interface SavePdfResult {
  saved: boolean
  path?: string
  error?: string
}

/**
 * Renders the HTML in a hidden window with JavaScript off, prints it to an A4
 * PDF, and asks where to save it.
 *
 * The HTML goes through a temporary file rather than a data: URL, because a
 * long doc would pass the length Chromium accepts for one. The window never
 * shows, never runs script, never navigates anywhere else, and is destroyed
 * whatever happens -- but it is not sandboxed from the network. Chromium
 * still fetches ordinary subresources (an `<img>` or `@font-face` the doc's
 * own Markdown/HTML references) to render them into the PDF, the same way a
 * browser tab would. That is a deliberate choice, not an oversight: SwarmClaw
 * keeps remote images working in exported PDFs rather than blocking every
 * subresource load, at the cost of the export making an outbound request per
 * image/font the moment "Export PDF" runs.
 */
export async function savePdfFromHtml(parent: BrowserWindow | null, raw: unknown): Promise<SavePdfResult> {
  const input = readSavePdfInput(raw)
  if (!input) return { saved: false, error: 'invalid input' }
  let dir: string | null = null
  let win: BrowserWindow | null = null
  try {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'swarmclaw-pdf-'))
    const htmlPath = path.join(dir, 'doc.html')
    win = new BrowserWindow({ show: false, webPreferences: { javascript: false, sandbox: true, contextIsolation: true } })

    // The HTML is a doc's own content rendered to a page -- untrusted from
    // here. `javascript: false` stops script, but a script-free construct
    // (a <meta http-equiv="refresh">, or a redirect from a remote resource
    // the page references) can still move this window off the loaded file
    // before printToPDF runs, so the PDF would silently print whatever the
    // window navigated to instead of the requested HTML. This window has no
    // legitimate destination other than the temp file it is about to load,
    // so every navigation and every new-window request is denied outright --
    // unlike `attachExternalNavigationHandlers` in `main.ts`, there is no
    // origin to allow.
    win.webContents.on('will-navigate', (event) => event.preventDefault())
    win.webContents.on('will-redirect', (event) => event.preventDefault())
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))

    await fs.writeFile(htmlPath, input.html, 'utf8')
    await win.loadFile(htmlPath)
    // `loadFile` resolving means the HTML parsed and initial layout ran, not
    // that the embedded @font-face has been swapped in -- font-display: swap
    // (see print-html.ts) means headings render in a fallback font first and
    // Chromium repaints once the ~34 kB embedded woff2 decodes. This window
    // runs with `javascript: false`, so `document.fonts.ready` isn't
    // reachable to await properly. A real, unbounded wait isn't an option
    // either -- a font fetch can hang or fail, and the export must still
    // complete. So: a short, fixed delay that is comfortably longer than a
    // local embedded-font swap needs, capping how long "Export PDF" can be
    // stalled by a font that never arrives.
    await new Promise((resolve) => setTimeout(resolve, 300))
    const pdf = await win.webContents.printToPDF({ printBackground: true, pageSize: 'A4' })
    const options = {
      defaultPath: path.join(app.getPath('downloads'), safePdfFileName(input.fileName)),
      filters: [{ name: 'PDF', extensions: ['pdf'] }],
    }
    const choice = parent ? await dialog.showSaveDialog(parent, options) : await dialog.showSaveDialog(options)
    if (choice.canceled || !choice.filePath) return { saved: false }
    await fs.writeFile(choice.filePath, pdf)
    return { saved: true, path: choice.filePath }
  } catch (err) {
    return { saved: false, error: err instanceof Error ? err.message : String(err) }
  } finally {
    win?.destroy()
    if (dir) await fs.rm(dir, { recursive: true, force: true })
  }
}
