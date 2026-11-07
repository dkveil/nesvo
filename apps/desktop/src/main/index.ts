import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { app, BrowserWindow, ipcMain } from 'electron';
import { startHost } from './host-client';

app.setName('Nesvo');
const smokeTest = process.env.NESVO_SMOKE_TEST === '1';
if (process.env.NESVO_DATA_DIR)
  app.setPath('userData', process.env.NESVO_DATA_DIR);

void app.whenReady().then(() => {
  const host = startHost(join(app.getPath('userData'), 'host'));
  if (smokeTest && process.env.NESVO_TEST_PID_FILE) {
    host.child.once('spawn', () => {
      writeFileSync(
        process.env.NESVO_TEST_PID_FILE!,
        JSON.stringify({ host: host.child.pid }),
      );
    });
  }
  let window: BrowserWindow | null = null;
  const createWindow = () => {
    const next = new BrowserWindow({
      width: 1000,
      height: 720,
      minWidth: 640,
      minHeight: 480,
      title: 'Nesvo',
      show: !smokeTest,
      autoHideMenuBar: true,
      webPreferences: {
        preload: join(import.meta.dirname, '../preload/index.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    window = next;
    next.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    next.webContents.on('will-navigate', event => event.preventDefault());
    next.webContents.session.setPermissionRequestHandler(
      (_contents, _permission, callback) => callback(false),
    );
    next.on('closed', () => {
      if (window === next) window = null;
    });
    if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) {
      void next.loadURL(process.env.ELECTRON_RENDERER_URL);
    } else {
      void next.loadFile(join(import.meta.dirname, '../renderer/index.html'));
    }
  };
  ipcMain.handle('nesvo:health', async event => {
    if (
      !window ||
      event.sender !== window.webContents ||
      event.senderFrame !== window.webContents.mainFrame
    ) {
      throw new Error('Unauthorized caller');
    }
    return host.health();
  });
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin' || smokeTest) app.quit();
  });
  let closing = false;
  let closed = false;
  app.on('before-quit', event => {
    if (closed) return;
    event.preventDefault();
    if (closing) return;
    closing = true;
    void host.stop().finally(() => {
      closed = true;
      app.quit();
    });
  });
});
