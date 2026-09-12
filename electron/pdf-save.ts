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
 * shows, never runs script, and is destroyed whatever happens.
 */
export async function savePdfFromHtml(parent: BrowserWindow | null, raw: unknown): Promise<SavePdfResult> {
  const input = readSavePdfInput(raw)
  if (!input) return { saved: false, error: 'invalid input' }
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'swarmclaw-pdf-'))
  const htmlPath = path.join(dir, 'doc.html')
  const win = new BrowserWindow({ show: false, webPreferences: { javascript: false, sandbox: true, contextIsolation: true } })
  try {
    await fs.writeFile(htmlPath, input.html, 'utf8')
    await win.loadFile(htmlPath)
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
    win.destroy()
    await fs.rm(dir, { recursive: true, force: true })
  }
}
