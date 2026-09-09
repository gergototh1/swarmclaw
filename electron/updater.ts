import { app, dialog, shell } from 'electron'
import { autoUpdater } from 'electron-updater'

const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000
const DOWNLOADS_URL = 'https://swarmclaw.ai/downloads'

export function initAutoUpdater(): void {
  if (!app.isPackaged) return

  autoUpdater.autoDownload = canAutoDownload()
  autoUpdater.autoInstallOnAppQuit = canAutoDownload()

  autoUpdater.on('error', (err) => {
    console.error('[updater] error', err)
  })

  if (!canAutoDownload()) {
    autoUpdater.on('update-available', (info) => {
      void dialog
        .showMessageBox({
          type: 'info',
          buttons: ['Open Downloads', 'Later'],
          defaultId: 0,
          cancelId: 1,
          title: 'SidekickOS update available',
          message: `Version ${info.version} is available.`,
          detail: 'Unsigned macOS builds cannot auto-update. Download the new version from swarmclaw.ai/downloads.',
        })
        .then((res) => {
          if (res.response === 0) void shell.openExternal(DOWNLOADS_URL)
        })
    })
  } else {
    autoUpdater.on('update-downloaded', (info) => {
      void dialog
        .showMessageBox({
          type: 'info',
          buttons: ['Restart now', 'Later'],
          defaultId: 0,
          cancelId: 1,
          title: 'Update ready',
          message: `SwarmClaw ${info.version} is ready to install.`,
          detail: 'Restart the app to apply the update.',
        })
        .then((res) => {
          if (res.response === 0) autoUpdater.quitAndInstall()
        })
    })
  }

  void autoUpdater.checkForUpdates()
  setInterval(() => void autoUpdater.checkForUpdates(), CHECK_INTERVAL_MS)
}

function canAutoDownload(): boolean {
  // Unsigned macOS builds cannot be verified by Squirrel.Mac. Notify-only
  // until code signing is set up. Windows NSIS + Linux AppImage handle
  // unsigned auto-update fine.
  return process.platform !== 'darwin'
}
