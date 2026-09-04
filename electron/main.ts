import { app, BrowserWindow, dialog, nativeImage, shell, WebContents } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { resolveRuntimePaths, RuntimePaths } from './paths'
import { ServerHandle, startEmbeddedServer, tailLogFile } from './server-lifecycle'
import { buildAppMenu } from './menu'
import { shouldOpenExternally } from './external-navigation'

const DEV_URL_DEFAULT = 'http://127.0.0.1:3456'
const LOG_TAIL_BYTES = 1500

let mainWindow: BrowserWindow | null = null
let serverHandle: ServerHandle | null = null
let serverLogFile: string | null = null
let isQuitting = false

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })

  app.on('ready', () => void onReady())

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })

  app.on('activate', () => {
    if (mainWindow !== null) return
    if (serverHandle) {
      createMainWindow(serverHandle.url)
    } else if (!app.isPackaged) {
      createMainWindow(process.env.SWARMCLAW_DEV_URL || DEV_URL_DEFAULT)
    }
  })

  app.on('before-quit', () => {
    isQuitting = true
  })

  app.on('will-quit', async (event) => {
    if (!serverHandle) return
    event.preventDefault()
    try {
      await serverHandle.stop()
    } finally {
      serverHandle = null
      app.exit(0)
    }
  })
}

async function onReady(): Promise<void> {
  const paths = resolveRuntimePaths()
  buildAppMenu(paths, () => mainWindow)

  const iconPath = resolveIconPath()
  if (process.platform === 'darwin' && iconPath && app.dock) {
    const img = nativeImage.createFromPath(iconPath)
    if (!img.isEmpty()) app.dock.setIcon(img)
  }

  if (!app.isPackaged) {
    const devUrl = process.env.SWARMCLAW_DEV_URL || DEV_URL_DEFAULT
    console.log(`[swarmclaw] dev mode, loading ${devUrl}`)
    createMainWindow(devUrl)
    return
  }

  serverLogFile = path.join(app.getPath('userData'), 'logs', 'server.log')
  fs.mkdirSync(path.dirname(serverLogFile), { recursive: true })

  try {
    serverHandle = await startEmbeddedServer({
      paths,
      logFile: serverLogFile,
      onStdout: (c) => process.stdout.write(`[swarmclaw] ${c}`),
      onStderr: (c) => process.stderr.write(`[swarmclaw] ${c}`),
      onExit: (code, signal) => {
        if (!isQuitting) {
          console.error(`[swarmclaw] server exited unexpectedly (code=${code}, signal=${signal ?? 'none'})`)
          void showServerCrashDialog(code, signal)
        }
      },
    })
  } catch (err) {
    await showStartupFailureDialog(err, paths)
    app.exit(1)
    return
  }

  createMainWindow(serverHandle.url)
  void import('./updater').then((m) => m.initAutoUpdater())
}

function resolveIconPath(): string | undefined {
  const candidate = app.isPackaged
    ? path.join(process.resourcesPath, 'icon.png')
    : path.join(__dirname, '..', 'resources', 'icon.png')
  return fs.existsSync(candidate) ? candidate : undefined
}

function createMainWindow(startUrl: string): void {
  const iconPath = resolveIconPath()
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 640,
    backgroundColor: '#0b0b0f',
    show: true,
    ...(iconPath ? { icon: iconPath } : {}),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })

  const wc = mainWindow.webContents
  if (!app.isPackaged) wc.openDevTools({ mode: 'detach' })

  wc.on('did-start-loading', () => console.log('[swarmclaw] did-start-loading'))
  wc.on('did-finish-load', () => console.log('[swarmclaw] did-finish-load'))
  wc.on('did-fail-load', (_e, code, desc, url) =>
    console.error(`[swarmclaw] did-fail-load code=${code} desc=${desc} url=${url}`),
  )
  wc.on('render-process-gone', (_e, details) =>
    console.error(`[swarmclaw] render-process-gone reason=${details.reason}`),
  )
  wc.on('unresponsive', () => console.error('[swarmclaw] webContents unresponsive'))

  mainWindow.on('closed', () => {
    mainWindow = null
  })

  attachExternalNavigationHandlers(wc, startUrl)

  void mainWindow.loadURL(startUrl).catch((err) => {
    console.error('[swarmclaw] loadURL rejected:', err)
  })
}

/**
 * Route navigation that leaves the app's own origin to the system browser.
 *
 * Three ways out of the window, and Google consent can take any of them, so all
 * three are covered:
 *
 * - `will-navigate` fires when the page itself starts a navigation. A click on
 *   an in-app link to `/api/oauth/google/start` raises it with the *app-origin*
 *   URL, which correctly stays in the window.
 * - `will-redirect` fires for the server-side hop that follows: the start route
 *   answers 302 to `accounts.google.com`. This is the event that carries the
 *   Google URL, and with nothing handling it the consent screen loads inside
 *   Electron, where Google refuses it with `disallowed_useragent`.
 * - `setWindowOpenHandler` covers `window.open` and `target=_blank`. It uses the
 *   same origin test as the two events rather than a prefix of the start URL, so
 *   `http://127.0.0.1:34560` is no longer read as the app on port 3456. An
 *   allowed child window then gets these same handlers through
 *   `did-create-window`, so a start URL opened in a new window redirects out to
 *   the browser just as one in the main window does.
 *
 * The `preventDefault` on `will-redirect` cancels the whole navigation, not only
 * the redirect, which is what is wanted: the window stays where it was and the
 * consent screen opens outside.
 */
function attachExternalNavigationHandlers(contents: WebContents, appUrl: string): void {
  // Typed by the shape it uses, so one listener serves both events without
  // naming either event's parameter interface.
  const externalise = (event: { preventDefault: () => void }, url: string): void => {
    if (!shouldOpenExternally(url, appUrl)) return
    event.preventDefault()
    void shell.openExternal(url)
  }

  contents.on('will-navigate', externalise)
  contents.on('will-redirect', externalise)

  contents.setWindowOpenHandler(({ url }) => {
    if (!shouldOpenExternally(url, appUrl)) return { action: 'allow' }
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  contents.on('did-create-window', (child) => {
    attachExternalNavigationHandlers(child.webContents, appUrl)
  })
}

async function showServerCrashDialog(code: number | null, signal: NodeJS.Signals | null): Promise<void> {
  const buttons = serverLogFile ? ['Open Logs Folder', 'Quit'] : ['Quit']
  const quitButtonId = buttons.length - 1
  const detail = buildLogDetail(`code=${code ?? 'null'} signal=${signal ?? 'none'}`)
  const res = await dialog.showMessageBox({
    type: 'error',
    buttons,
    defaultId: quitButtonId,
    cancelId: quitButtonId,
    title: 'SwarmClaw stopped',
    message: 'The SwarmClaw server exited unexpectedly.',
    detail,
  })
  if (serverLogFile && res.response === 0) shell.showItemInFolder(serverLogFile)
  app.exit(1)
}

async function showStartupFailureDialog(err: unknown, paths: RuntimePaths): Promise<void> {
  const message = err instanceof Error ? err.message : String(err)
  const base = `${message}\n\nStandalone entry: ${paths.standaloneEntry}\nData dir: ${paths.dataDir}`
  const detail = buildLogDetail(base)
  const buttons = serverLogFile ? ['Open Logs Folder', 'Quit'] : ['Quit']
  const quitButtonId = buttons.length - 1
  const res = await dialog.showMessageBox({
    type: 'error',
    buttons,
    defaultId: quitButtonId,
    cancelId: quitButtonId,
    title: 'SwarmClaw failed to start',
    message: 'The embedded server did not start.',
    detail,
  })
  if (serverLogFile && res.response === 0) shell.showItemInFolder(serverLogFile)
}

function buildLogDetail(base: string): string {
  if (!serverLogFile) return base
  const tail = tailLogFile(serverLogFile, LOG_TAIL_BYTES).trim()
  if (!tail) return `${base}\n\nLog file: ${serverLogFile}\n(no output captured yet)`
  return `${base}\n\nLog tail (${serverLogFile}):\n${tail}`
}
