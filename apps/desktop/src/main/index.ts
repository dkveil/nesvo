import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { app, BrowserWindow, ipcMain, nativeTheme } from 'electron';
import { startHost } from './host-client';
import { ComputerManager } from './computer-manager';
import { mobileAccess } from './mobile-access';
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
  readGitBranchSchema,
  discoverSkillsSchema,
  hostIdSchema,
  sshComputerInputSchema,
  providerUsageInputSchema,
  mobileDeviceSchema,
  deleteScheduledJobSchema,
  listScheduledJobRunsSchema,
  listScheduledJobsSchema,
  runScheduledJobNowSchema,
  saveScheduledJobSchema,
  setScheduledJobActiveSchema,
} from '@nesvo/contracts';

app.setName('Nesvo');
nativeTheme.themeSource = 'dark';
const TITLE_BAR_HEIGHT = 44;
const titleBarOptions = (
  platform: NodeJS.Platform,
): Electron.BrowserWindowConstructorOptions =>
  platform === 'darwin'
    ? {
        titleBarStyle: 'hiddenInset',
        trafficLightPosition: { x: 16, y: TITLE_BAR_HEIGHT / 2 - 7 },
      }
    : {
        titleBarStyle: 'hidden',
        titleBarOverlay: {
          color: '#01000000',
          symbolColor: '#a3a3a3',
          height: TITLE_BAR_HEIGHT,
        },
      };
const smokeTest = process.env.NESVO_SMOKE_TEST === '1';
if (process.env.NESVO_DATA_DIR)
  app.setPath('userData', process.env.NESVO_DATA_DIR);

const ownsInstance = app.requestSingleInstanceLock();
if (!ownsInstance) app.quit();
void app.whenReady().then(async () => {
  if (!ownsInstance) return;
  const host = startHost(join(app.getPath('userData'), 'host'));
  const computers = new ComputerManager(app.getPath('userData'), host);
  const mobile = mobileAccess(app.getPath('userData'), computers);
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
      ...titleBarOptions(process.platform),
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
  computers.subscribe(event => {
    if (window && !window.isDestroyed())
      window.webContents.send('nesvo:event', event);
  });
  ipcMain.handle('nesvo:mobile-status', event => {
    authorize(event);
    return mobile.status();
  });
  ipcMain.handle('nesvo:enable-mobile', event => {
    authorize(event);
    return mobile.enable();
  });
  ipcMain.handle('nesvo:disable-mobile', event => {
    authorize(event);
    return mobile.disable();
  });
  ipcMain.handle('nesvo:pair-mobile', event => {
    authorize(event);
    return mobile.pair();
  });
  ipcMain.handle('nesvo:revoke-mobile', (event, deviceId: unknown) => {
    authorize(event);
    return mobile.revoke(mobileDeviceSchema.shape.id.parse(deviceId));
  });
  ipcMain.handle('nesvo:list-computers', event => {
    authorize(event);
    return computers.listComputers();
  });
  ipcMain.handle('nesvo:add-computer', (event, input: unknown) => {
    authorize(event);
    return computers.addComputer(sshComputerInputSchema.parse(input));
  });
  ipcMain.handle('nesvo:connect-computer', (event, hostId: unknown) => {
    authorize(event);
    return computers.connectComputer(hostIdSchema.parse(hostId));
  });
  ipcMain.handle('nesvo:disconnect-computer', (event, hostId: unknown) => {
    authorize(event);
    return computers.disconnectComputer(hostIdSchema.parse(hostId));
  });
  ipcMain.handle('nesvo:remove-computer', (event, hostId: unknown) => {
    authorize(event);
    return computers.removeComputer(hostIdSchema.parse(hostId));
  });
  const route = (hostId: unknown) => hostIdSchema.parse(hostId ?? 'local');
  ipcMain.handle(
    'nesvo:provider-usage',
    (event, input: unknown, hostId: unknown) => {
      authorize(event);
      return computers.execute(
        'provider-usage',
        providerUsageInputSchema.parse(input),
        route(hostId),
      );
    },
  );
  ipcMain.handle('nesvo:health', async (event, hostId: unknown) => {
    authorize(event);
    return computers.execute('health', undefined, route(hostId));
  });
  ipcMain.handle('nesvo:claude-status', async (event, hostId: unknown) => {
    authorize(event);
    return computers.execute('claude-status', undefined, route(hostId));
  });
  ipcMain.handle('nesvo:codex-status', async (event, hostId: unknown) => {
    authorize(event);
    return computers.execute('codex-status', undefined, route(hostId));
  });
  ipcMain.handle(
    'nesvo:decide-delegation',
    async (event, input: unknown, hostId: unknown) => {
      authorize(event);
      return computers.execute(
        'decide-delegation',
        decideDelegationSchema.parse(input),
        route(hostId),
      );
    },
  );
  ipcMain.handle(
    'nesvo:respond-approval',
    async (event, input: unknown, hostId: unknown) => {
      authorize(event);
      return computers.execute(
        'respond-approval',
        respondApprovalSchema.parse(input),
        route(hostId),
      );
    },
  );
  ipcMain.handle('nesvo:list-sessions', async (event, hostId: unknown) => {
    authorize(event);
    return computers.listSessions(hostIdSchema.optional().parse(hostId));
  });
  ipcMain.handle('nesvo:list-reviews', async (event, hostId: unknown) => {
    authorize(event);
    return computers.listReviews(hostIdSchema.optional().parse(hostId));
  });
  ipcMain.handle(
    'nesvo:discover-skills',
    async (event, input: unknown, hostId: unknown) => {
      authorize(event);
      return computers.execute(
        'discover-skills',
        discoverSkillsSchema.parse(input),
        route(hostId),
      );
    },
  );
  ipcMain.handle(
    'nesvo:read-git-branch',
    async (event, input: unknown, hostId: unknown) => {
      authorize(event);
      return computers.execute(
        'read-git-branch',
        readGitBranchSchema.parse(input),
        route(hostId),
      );
    },
  );
  ipcMain.handle(
    'nesvo:list-workspace-directory',
    async (event, input: unknown, hostId: unknown) => {
      authorize(event);
      return computers.execute(
        'list-workspace-directory',
        listWorkspaceDirectorySchema.parse(input),
        route(hostId),
      );
    },
  );
  ipcMain.handle(
    'nesvo:search-workspace-files',
    async (event, input: unknown, hostId: unknown) => {
      authorize(event);
      return computers.execute(
        'search-workspace-files',
        searchWorkspaceFilesSchema.parse(input),
        route(hostId),
      );
    },
  );
  ipcMain.handle(
    'nesvo:read-workspace-file',
    async (event, input: unknown, hostId: unknown) => {
      authorize(event);
      return computers.execute(
        'read-workspace-file',
        readWorkspaceFileSchema.parse(input),
        route(hostId),
      );
    },
  );
  ipcMain.handle(
    'nesvo:decide-review',
    async (event, input: unknown, hostId: unknown) => {
      authorize(event);
      return computers.execute(
        'decide-review',
        decideReviewSchema.parse(input),
        route(hostId),
      );
    },
  );
  ipcMain.handle('nesvo:list-scheduled-jobs', (event, hostId: unknown) => {
    authorize(event);
    return computers.executeScheduledJob(
      'list-scheduled-jobs',
      listScheduledJobsSchema.parse({}),
      hostIdSchema.parse(hostId),
    );
  });
  ipcMain.handle(
    'nesvo:save-scheduled-job',
    (event, input: unknown, hostId: unknown) => {
      authorize(event);
      return computers.executeScheduledJob(
        'save-scheduled-job',
        saveScheduledJobSchema.parse(input),
        hostIdSchema.parse(hostId),
      );
    },
  );
  ipcMain.handle(
    'nesvo:set-scheduled-job-active',
    (event, input: unknown, hostId: unknown) => {
      authorize(event);
      return computers.executeScheduledJob(
        'set-scheduled-job-active',
        setScheduledJobActiveSchema.parse(input),
        hostIdSchema.parse(hostId),
      );
    },
  );
  ipcMain.handle(
    'nesvo:delete-scheduled-job',
    (event, input: unknown, hostId: unknown) => {
      authorize(event);
      return computers.executeScheduledJob(
        'delete-scheduled-job',
        deleteScheduledJobSchema.parse(input),
        hostIdSchema.parse(hostId),
      );
    },
  );
  ipcMain.handle(
    'nesvo:run-scheduled-job-now',
    (event, input: unknown, hostId: unknown) => {
      authorize(event);
      return computers.executeScheduledJob(
        'run-scheduled-job-now',
        runScheduledJobNowSchema.parse(input),
        hostIdSchema.parse(hostId),
      );
    },
  );
  ipcMain.handle(
    'nesvo:list-scheduled-job-runs',
    (event, input: unknown, hostId: unknown) => {
      authorize(event);
      return computers.executeScheduledJob(
        'list-scheduled-job-runs',
        listScheduledJobRunsSchema.parse(input),
        hostIdSchema.parse(hostId),
      );
    },
  );
  ipcMain.handle(
    'nesvo:create-session',
    async (event, input: unknown, hostId: unknown) => {
      authorize(event);
      return computers.execute(
        'create-session',
        createSessionSchema.parse(input),
        route(hostId),
      );
    },
  );
  ipcMain.handle(
    'nesvo:send-message',
    async (event, input: unknown, hostId: unknown) => {
      authorize(event);
      return computers.execute(
        'send-message',
        sendMessageSchema.parse(input),
        route(hostId),
      );
    },
  );
  ipcMain.handle(
    'nesvo:stop-run',
    async (event, input: unknown, hostId: unknown) => {
      authorize(event);
      return computers.execute(
        'stop-run',
        stopRunSchema.parse(input),
        route(hostId),
      );
    },
  );
  await computers.initialize();
  createWindow();
  app.on('second-instance', () => {
    if (!window) createWindow();
    if (window && !smokeTest) {
      if (window.isMinimized()) window.restore();
      window.show();
      window.focus();
    }
  });
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
    void mobile
      .close()
      .catch(() => undefined)
      .then(() => computers.close())
      .finally(() => {
        closed = true;
        app.quit();
      });
  });
});
