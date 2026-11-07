import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { app, BrowserWindow, ipcMain, nativeTheme } from 'electron';
import { startHost } from './host-client';
import {
  createSessionSchema,
  decideDelegationSchema,
  decideReviewSchema,
  respondApprovalSchema,
  sendMessageSchema,
  stopRunSchema,
  listWorkspaceDirectorySchema,
  searchWorkspaceFilesSchema,
  readWorkspaceFileSchema,
  discoverSkillsSchema,
} from '@nesvo/contracts';

app.setName('Nesvo');
nativeTheme.themeSource = 'dark';
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
      width: 1320,
      height: 860,
      minWidth: 640,
      minHeight: 480,
      title: 'Nesvo',
      backgroundColor: '#000000',
      show: !smokeTest,
      autoHideMenuBar: true,
      webPreferences: {
        preload: join(import.meta.dirname, '../preload/index.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        backgroundThrottling: !smokeTest,
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
  const authorize = (event: Electron.IpcMainInvokeEvent) => {
    if (
      !window ||
      event.sender !== window.webContents ||
      event.senderFrame !== window.webContents.mainFrame
    ) {
      throw new Error('Unauthorized caller');
    }
  };
  host.subscribe(event => {
    if (window && !window.isDestroyed())
      window.webContents.send('nesvo:event', event);
  });
  ipcMain.handle('nesvo:health', async event => {
    authorize(event);
    return host.health();
  });
  ipcMain.handle('nesvo:claude-status', async event => {
    authorize(event);
    return host.claudeStatus();
  });
  ipcMain.handle('nesvo:codex-status', async event => {
    authorize(event);
    return host.codexStatus();
  });
  ipcMain.handle('nesvo:decide-delegation', async (event, input: unknown) => {
    authorize(event);
    return host.decideDelegation(decideDelegationSchema.parse(input));
  });
  ipcMain.handle('nesvo:respond-approval', async (event, input: unknown) => {
    authorize(event);
    return host.respondApproval(respondApprovalSchema.parse(input));
  });
  ipcMain.handle('nesvo:list-sessions', async event => {
    authorize(event);
    return host.listSessions();
  });
  ipcMain.handle('nesvo:list-reviews', async event => {
    authorize(event);
    return host.listReviews();
  });
  ipcMain.handle('nesvo:discover-skills', async (event, input: unknown) => {
    authorize(event);
    return host.discoverSkills(discoverSkillsSchema.parse(input));
  });
  ipcMain.handle(
    'nesvo:list-workspace-directory',
    async (event, input: unknown) => {
      authorize(event);
      return host.listWorkspaceDirectory(
        listWorkspaceDirectorySchema.parse(input),
      );
    },
  );
  ipcMain.handle(
    'nesvo:search-workspace-files',
    async (event, input: unknown) => {
      authorize(event);
      return host.searchWorkspaceFiles(searchWorkspaceFilesSchema.parse(input));
    },
  );
  ipcMain.handle('nesvo:read-workspace-file', async (event, input: unknown) => {
    authorize(event);
    return host.readWorkspaceFile(readWorkspaceFileSchema.parse(input));
  });
  ipcMain.handle('nesvo:decide-review', async (event, input: unknown) => {
    authorize(event);
    return host.decideReview(decideReviewSchema.parse(input));
  });
  ipcMain.handle('nesvo:create-session', async (event, input: unknown) => {
    authorize(event);
    return host.createSession(createSessionSchema.parse(input));
  });
  ipcMain.handle('nesvo:send-message', async (event, input: unknown) => {
    authorize(event);
    return host.sendMessage(sendMessageSchema.parse(input));
  });
  ipcMain.handle('nesvo:stop-run', async (event, input: unknown) => {
    authorize(event);
    return host.stopRun(stopRunSchema.parse(input));
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
