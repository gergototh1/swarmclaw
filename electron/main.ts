import { app, BrowserWindow, dialog, nativeImage, shell, WebContents } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { resolveRuntimePaths, RuntimePaths } from './paths'
import { ServerHandle, startEmbeddedServer, tailLogFile } from './server-lifecycle'
import { buildAppMenu } from './menu'
import { shouldExternaliseNavigation, shouldOpenExternally } from './external-navigation'

const DEV_URL_DEFAULT = 'http://127.0.0.1:3456'
const LOG_TAIL_BYTES = 1500

let mainWindow: BrowserWindow | null = null
let serverHandle: ServerHandle | null = null
let serverLogFile: string | null = null
let isQuitting = false

/*
 * A RENAME MUST NOT MOVE THE DATA.
 *
 * `app.getPath('userData')` is derived from the packaged app's name, and that
 * is `productName` in electron-builder.yml -- which the SidekickOS rename
 * changed. Left alone, the next packaged build would look for its home under a
 * new directory and start with no agents, no sessions and no extensions, while
 * the old ones sat untouched next to it. `paths.ts` builds every runtime
 * directory from this one call, so pinning it here is enough.
 *
 * The literal is the directory this install already uses: `package.json`'s
 * `name` is what Electron used before a productName existed. It is a path, not
 * a brand, and it stays.
 */
const USER_DATA_DIR_NAME = '@swarmclawai/swarmclaw'
app.setPath('userData', path.join(app.getPath('appData'), USER_DATA_DIR_NAME))

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
 * - `will-navigate` fires when the page itself starts a navigation, and is
 *   documented as firing for the main frame only. A click on an in-app link to
 *   `/api/oauth/google/start` raises it with the *app-origin* URL, which
 *   correctly stays in the window.
 * - `will-redirect` fires for the server-side hop that follows: the start route
 *   answers 302 to `accounts.google.com`. This is the event that carries the
 *   Google URL, and with nothing handling it the consent screen loads inside
 *   Electron, where Google refuses it with `disallowed_useragent`. Unlike
 *   `will-navigate`, `will-redirect` carries no main-frame-only restriction in
 *   its documentation, its params interface includes `isMainFrame` for exactly
 *   that reason, and it fires after `did-start-navigation`, which is documented
 *   as firing for any frame, subframes included. The app renders cross-origin
 *   iframes of its own — a YouTube embed in `markdown-body.tsx`, an arbitrary
 *   preview URL in `chat-preview-panel.tsx` — and a redirect inside one of
 *   those (a plain `http` to `https` hop, YouTube's regional consent hop) must
 *   stay inside the iframe rather than cancel its navigation and open the
 *   system browser. So both listeners below read `isMainFrame` off the
 *   non-deprecated `details` argument, which is what carries it, and only act
 *   when it is `true`; a subframe redirect or navigation is left alone.
 * - `setWindowOpenHandler` covers `window.open` and `target=_blank`, which
 *   always target a new top-level browsing context rather than a subframe, so
 *   it needs no such gate. It uses the same origin test as the two events
 *   rather than a prefix of the start URL, so `http://127.0.0.1:34560` is no
 *   longer read as the app on port 3456. An allowed child window then gets
 *   these same handlers through `did-create-window`, so a start URL opened in
 *   a new window redirects out to the browser just as one in the main window
 *   does.
 *
 * The `preventDefault` on `will-redirect` cancels the whole navigation, not only
 * the redirect, which is what is wanted for the main frame: the window stays
 * where it was and the consent screen opens outside.
 */
function attachExternalNavigationHandlers(contents: WebContents, appUrl: string): void {
  // Typed by the shape it uses, so one listener serves both events without
  // naming either event's parameter interface. Reads only the non-deprecated
  // `details` argument (both events also still pass the deprecated positional
  // `url`/`isMainFrame`/etc. arguments after it, which this ignores) so that
  // `isMainFrame` is actually in reach — `shouldExternaliseNavigation` is what
  // consults it.
  const externalise = (details: { preventDefault: () => void; url: string; isMainFrame: boolean }): void => {
    if (!shouldExternaliseNavigation(details, appUrl)) return
    details.preventDefault()
    void shell.openExternal(details.url)
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
    title: 'SidekickOS stopped',
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
    title: 'SidekickOS failed to start',
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
