import type { BrowserWindow } from 'electron'

let _win: BrowserWindow | null = null

export function setMainWindow(win: BrowserWindow): void {
  _win = win
}

export function sendToRenderer(channel: string, data: unknown): void {
  try {
    if (_win && !_win.isDestroyed()) {
      _win.webContents.send(channel, data)
    }
  } catch {
    /* renderer not ready yet */
  }
}
