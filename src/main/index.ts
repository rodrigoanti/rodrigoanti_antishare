import { app, BrowserWindow, shell } from 'electron'
import { existsSync } from 'fs'
import { join } from 'path'
import { registerIpc, restoreAutoStart, shutdownShare } from './ipc'
import { requestLocalNetworkAccess } from './localNetworkAccess'

function resolveAppIcon(): string | undefined {
  const candidates = [
    join(process.resourcesPath, 'icon.png'),
    join(__dirname, '../../build/icon.ico'),
    join(__dirname, '../../build/icon.png')
  ]
  return candidates.find((p) => existsSync(p))
}

function createWindow(): void {
  const icon = resolveAppIcon()
  const isMac = process.platform === 'darwin'
  const win = new BrowserWindow({
    width: 960,
    height: 680,
    show: false,
    title: 'AntiShare',
    ...(icon ? { icon } : {}),
    // Inset traffic lights so the app toolbar is the only header band.
    ...(isMac
      ? { titleBarStyle: 'hiddenInset' as const, trafficLightPosition: { x: 16, y: 16 } }
      : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  win.on('ready-to-show', () => {
    win.show()
    requestLocalNetworkAccess()
  })
  // Last line of defense: the app window never leaves its own page (e.g. an unhandled file drop).
  win.webContents.on('will-navigate', (e, url) => {
    if (url !== win.webContents.getURL()) e.preventDefault()
  })
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(async () => {
  registerIpc()
  await restoreAutoStart()
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  void shutdownShare()
})
