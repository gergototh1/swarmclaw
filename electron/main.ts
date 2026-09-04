import { app, BrowserWindow, dialog, nativeImage, shell } from 'electron'
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

  // `setWindowOpenHandler` only covers window.open and target=_blank. A plain
  // in-app link that redirects off-origin — Google consent is the one that
  // matters — navigates the existing window instead, and Google refuses to run
  // its consent screen inside Electron. Same-origin navigation is left alone, so
  // the app's own pages still load here.
  wc.on('will-navigate', (event, url) => {
    if (!shouldOpenExternally(url, startUrl)) return
    event.preventDefault()
    void shell.openExternal(url)
  })

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith(startUrl)) return { action: 'allow' }
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  void mainWindow.loadURL(startUrl).catch((err) => {
    console.error('[swarmclaw] loadURL rejected:', err)
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
