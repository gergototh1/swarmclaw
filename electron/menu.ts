import { app, BrowserWindow, Menu, MenuItemConstructorOptions, shell } from 'electron'
import { RuntimePaths } from './paths'
import { TAB_COMMAND_CHANNEL, tabMenuEntries } from './tab-menu'

export function buildAppMenu(paths: RuntimePaths, getWindow: () => BrowserWindow | null): void {
  const isMac = process.platform === 'darwin'

  const tabItem = (entry: ReturnType<typeof tabMenuEntries>[number]): MenuItemConstructorOptions => ({
    label: entry.label,
    accelerator: entry.accelerator,
    click: () => getWindow()?.webContents.send(TAB_COMMAND_CHANNEL, entry.command),
  })
  const tabEntries = tabMenuEntries(isMac)
  const tabActions = tabEntries.filter((e) => e.command.kind !== 'goto').map(tabItem)
  const tabPositions = tabEntries.filter((e) => e.command.kind === 'goto').map(tabItem)

  const macAppMenu: MenuItemConstructorOptions = {
    label: app.name,
    submenu: [
      { role: 'about' },
      { type: 'separator' },
      { role: 'services' },
      { type: 'separator' },
      { role: 'hide' },
      { role: 'hideOthers' },
      { role: 'unhide' },
      { type: 'separator' },
      { role: 'quit' },
    ],
  }

  const fileMenu: MenuItemConstructorOptions = {
    label: 'File',
    submenu: [
      ...tabActions,
      { type: 'separator' },
      {
        label: 'Open Data Folder',
        click: () => void shell.openPath(paths.swarmclawHome),
      },
      { type: 'separator' },
      // Cmd/Ctrl+W closes a tab now; the window moves to Shift+Cmd/Ctrl+W.
      { role: 'close', accelerator: isMac ? 'Shift+Cmd+W' : 'Ctrl+Shift+W' },
      ...(isMac ? [] : [{ role: 'quit' } as MenuItemConstructorOptions]),
    ],
  }

  const editMenu: MenuItemConstructorOptions = {
    label: 'Edit',
    submenu: [
      { role: 'undo' },
      { role: 'redo' },
      { type: 'separator' },
      { role: 'cut' },
      { role: 'copy' },
      { role: 'paste' },
      { role: 'selectAll' },
    ],
  }

  const viewMenu: MenuItemConstructorOptions = {
    label: 'View',
    submenu: [
      {
        label: 'Reload',
        accelerator: isMac ? 'Cmd+R' : 'Ctrl+R',
        click: () => getWindow()?.webContents.reload(),
      },
      {
        label: 'Force Reload',
        accelerator: isMac ? 'Shift+Cmd+R' : 'Ctrl+Shift+R',
        click: () => getWindow()?.webContents.reloadIgnoringCache(),
      },
      { type: 'separator' },
      { role: 'resetZoom' },
      { role: 'zoomIn' },
      { role: 'zoomOut' },
      { type: 'separator' },
      { role: 'togglefullscreen' },
      { role: 'toggleDevTools' },
    ],
  }

  const windowMenu: MenuItemConstructorOptions = {
    label: 'Window',
    submenu: isMac
      ? [
          { role: 'minimize' },
          { role: 'zoom' },
          { type: 'separator' },
          ...tabPositions,
          { type: 'separator' },
          { role: 'front' },
        ]
      : [{ role: 'minimize' }, { type: 'separator' }, ...tabPositions],
  }

  const helpMenu: MenuItemConstructorOptions = {
    role: 'help',
    submenu: [
      {
        label: 'SwarmClaw Website',
        click: () => void shell.openExternal('https://swarmclaw.ai'),
      },
      {
        label: 'Documentation',
        click: () => void shell.openExternal('https://swarmclaw.ai/docs'),
      },
      {
        label: 'Report an Issue',
        click: () => void shell.openExternal('https://github.com/swarmclawai/swarmclaw/issues'),
      },
    ],
  }

  const template: MenuItemConstructorOptions[] = [
    ...(isMac ? [macAppMenu] : []),
    fileMenu,
    editMenu,
    viewMenu,
    windowMenu,
    helpMenu,
  ]

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}
