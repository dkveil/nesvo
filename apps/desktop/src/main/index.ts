import { join } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeTheme,
  powerMonitor,
  shell,
} from 'electron';
import appIcon from '../../build/icons/256x256.png?asset';
import { startHost } from './host-client';
import { initializeLogging, log, logsDirectory } from './logging';
import {
  MIN_WINDOW_HEIGHT,
  MIN_WINDOW_WIDTH,
  readWindowState,
  saveWindowState,
} from './window-state';
import {
  ComputerManager,
  type CatalogWorkflowMethod,
} from './computer-manager';
import { mobileAccess } from './mobile-access';
import { aboutInfo, openLicenses, saveTextFile, showBackup } from './app-files';
import { readColorScheme, saveColorScheme } from './appearance-store';
import {
  createWorkflowDemo,
  isWorkflowDemoEnabled,
  type WorkflowDemo,
} from './workflow-demo';
import {
  colorSchemeSchema,
  createSessionSchema,
  readSessionWorktreeSchema,
  finishSessionWorktreeSchema,
  runSessionWorktreeSetupSchema,
  removeOrphanedSessionWorktreeSchema,
  decideDelegationSchema,
  decideWorkerPlanSchema,
  decideReviewSchema,
  respondApprovalSchema,
  getSessionSchema,
  readSessionMessagesSchema,
  assignSessionWorkflowSchema,
  forkSessionSchema,
  restartSessionSchema,
  createSessionGroupSchema,
  deleteSessionGroupSchema,
  moveSessionGroupSchema,
  moveSessionSchema,
  renameSessionSchema,
  setSessionArchivedSchema,
  setSessionPinnedSchema,
  updateSessionGroupSchema,
  sendMessageSchema,
  queuedMessageRefSchema,
  stopRunSchema,
  listWorkspaceDirectorySchema,
  searchWorkspaceFilesSchema,
  readWorkspaceFileSchema,
  readGitBranchSchema,
  historySearchInputSchema,
  adoptConversationSchema,
  listPullRequestsSchema,
  readPullRequestSchema,
  actOnPullRequestSchema,
  linkSessionPullRequestSchema,
  findSessionPullRequestSchema,
  discoverSkillsSchema,
  listMcpServersSchema,
  setSessionMcpSchema,
  hostIdSchema,
  sshComputerInputSchema,
  providerUsageInputSchema,
  readCostsSchema,
  createCostBudgetSchema,
  costBudgetSchema,
  deleteCostBudgetSchema,
  mobileDeviceSchema,
  decideScheduledJobStartSchema,
  deleteScheduledJobSchema,
  listScheduledJobRunsSchema,
  listScheduledJobsSchema,
  runScheduledJobNowSchema,
  saveScheduledJobSchema,
  setScheduledJobActiveSchema,
  decideWorkflowGateSchema,
  deleteWorkflowDefinitionSchema,
  getWorkflowRunSchema,
  listWorkflowDefinitionsSchema,
  listWorkflowRunsSchema,
  workflowMetricsInputSchema,
  workflowAssistantSendSchema,
  assistantUndoSchema,
  listAssistantChangesSchema,
  readWorkflowEvidenceSchema,
  removeWorkflowWorktreeSchema,
  resolveWorkflowStepSchema,
  resumeWorkflowRunSchema,
  runWorkflowStepsSchema,
  saveWorkflowDefinitionSchema,
  skipWorkflowStepSchema,
  startWorkflowTaskSchema,
  stopWorkflowRunSchema,
  validateWorkflowDefinitionsSchema,
  MAX_RENDERER_ERROR_REPORT_BYTES,
  rendererErrorReportSchema,
  type AppliedColorScheme,
  type DesktopSession,
  type WorkspaceEvent,
} from '@nesvo/contracts';

app.setName('Nesvo');
nativeTheme.themeSource = 'system';
const TITLE_BAR_HEIGHT = 40;
const appliedColorScheme = (): AppliedColorScheme =>
  nativeTheme.shouldUseDarkColors ? 'dark' : 'light';
const windowColors = () =>
  nativeTheme.shouldUseDarkColors
    ? { background: '#000000', symbol: '#f8fafc' }
    : { background: '#fcfcfc', symbol: '#1f2937' };
const titleBarOverlay = (): Electron.TitleBarOverlay => ({
  color: '#01000000',
  symbolColor: windowColors().symbol,
  height: TITLE_BAR_HEIGHT,
});
const titleBarOptions = (
  platform: NodeJS.Platform,
): Electron.BrowserWindowConstructorOptions =>
  platform === 'darwin'
    ? {
        titleBarStyle: 'hiddenInset',
        trafficLightPosition: { x: 16, y: TITLE_BAR_HEIGHT / 2 - 7 },
      }
    : { titleBarStyle: 'hidden', titleBarOverlay: titleBarOverlay() };
const workflowInputs = {
  'list-workflow-definitions': listWorkflowDefinitionsSchema,
  'validate-workflow-definitions': validateWorkflowDefinitionsSchema,
  'start-workflow-task': startWorkflowTaskSchema,
  'run-workflow-steps': runWorkflowStepsSchema,
  'list-workflow-runs': listWorkflowRunsSchema,
  'get-workflow-run': getWorkflowRunSchema,
  'decide-workflow-gate': decideWorkflowGateSchema,
  'skip-workflow-step': skipWorkflowStepSchema,
  'resume-workflow-run': resumeWorkflowRunSchema,
  'resolve-workflow-step': resolveWorkflowStepSchema,
  'stop-workflow-run': stopWorkflowRunSchema,
  'save-workflow-definition': saveWorkflowDefinitionSchema,
  'delete-workflow-definition': deleteWorkflowDefinitionSchema,
  'remove-workflow-worktree': removeWorkflowWorktreeSchema,
  'read-workflow-evidence': readWorkflowEvidenceSchema,
  'workflow-metrics': workflowMetricsInputSchema,
  'workflow-assistant-send': workflowAssistantSendSchema,
  'workflow-assistant-undo': assistantUndoSchema,
  'workflow-assistant-changes': listAssistantChangesSchema,
} satisfies Record<
  CatalogWorkflowMethod,
  { parse: (input: unknown) => unknown }
>;
const MAX_EXTERNAL_URL_LENGTH = 2048;
const RENDERER_CRASH_WINDOW_MS = 60_000;
const MAX_RENDERER_RELOADS_PER_WINDOW = 3;
const ERROR_REPORT_WINDOW_MS = 60_000;
const MAX_ERROR_REPORTS_PER_WINDOW = 30;
const smokeTest = process.env.NESVO_SMOKE_TEST === '1';
if (process.env.NESVO_DATA_DIR) {
  app.setPath('userData', process.env.NESVO_DATA_DIR);
  app.setAppLogsPath(join(process.env.NESVO_DATA_DIR, 'logs'));
}
initializeLogging(app.getPath('logs'), !app.isPackaged);
process.on('uncaughtException', error =>
  log.error('Uncaught exception in the main process.', error),
);
process.on('unhandledRejection', reason =>
  log.error('Unhandled promise rejection in the main process.', reason),
);
app.on('child-process-gone', (_event, details) =>
  log.error(
    `A ${details.type} process stopped: ${details.reason} (exit code ${details.exitCode}).`,
    details.name ?? details.serviceName ?? '',
  ),
);

const applyApplicationMenu = () => {
  if (!app.isPackaged) return;
  Menu.setApplicationMenu(
    process.platform === 'darwin'
      ? Menu.buildFromTemplate([
          { role: 'appMenu' },
          { role: 'editMenu' },
          { role: 'windowMenu' },
        ])
      : null,
  );
};

const describeIpcFailure = (channel: string, error: unknown) => {
  if (error instanceof Error && error.name === 'ZodError') {
    log.warn(`${channel} received invalid data.`, error.message);
    return new Error(
      'Nesvo received invalid data for this action. Reload the window and try again.',
    );
  }
  log.warn(
    `${channel} failed.`,
    error instanceof Error ? error.message : String(error),
  );
  return error instanceof Error ? error : new Error('The action failed.');
};

const handle = (
  channel: string,
  listener: (event: Electron.IpcMainInvokeEvent, ...args: unknown[]) => unknown,
) =>
  ipcMain.handle(channel, async (event, ...args: unknown[]) => {
    try {
      return await listener(event, ...args);
    } catch (error) {
      throw describeIpcFailure(channel, error);
    }
  });

const ownsInstance = app.requestSingleInstanceLock();
if (!ownsInstance) app.quit();
void app.whenReady().then(async () => {
  if (!ownsInstance) return;
  app.setAppUserModelId('app.nesvo.desktop');
  log.info(`Nesvo ${app.getVersion()} started.`);
  applyApplicationMenu();
  nativeTheme.themeSource = readColorScheme(app.getPath('userData'));
  const hostDirectory = join(app.getPath('userData'), 'host');
  const startLocalHost = () => {
    const host = startHost(hostDirectory);
    if (smokeTest && process.env.NESVO_TEST_PID_FILE)
      host.child.once('spawn', () => {
        writeFileSync(
          process.env.NESVO_TEST_PID_FILE!,
          JSON.stringify({ host: host.child.pid }),
        );
      });
    return host;
  };
  const computers = new ComputerManager(
    app.getPath('userData'),
    startLocalHost,
  );
  const mobile = mobileAccess(app.getPath('userData'), computers);
  let window: BrowserWindow | null = null;
  let quitting = false;
  app.once('before-quit', () => {
    quitting = true;
  });
  const loadRenderer = (target: BrowserWindow) => {
    if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) {
      void target.loadURL(process.env.ELECTRON_RENDERER_URL);
    } else {
      void target.loadFile(join(import.meta.dirname, '../renderer/index.html'));
    }
  };
  const offerRecovery = async (target: BrowserWindow) => {
    if (smokeTest || target.isDestroyed()) return;
    const { response } = await dialog.showMessageBox(target, {
      type: 'error',
      message: 'The Nesvo window keeps stopping',
      detail:
        'Work on your computers keeps running. Reload the window to try again, or open the logs to see what happened.',
      buttons: ['Reload window', 'Open logs', 'Quit Nesvo'],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
    if (target.isDestroyed()) return;
    if (response === 1) void shell.openPath(logsDirectory());
    else if (response === 2) app.quit();
    else loadRenderer(target);
  };
  const createWindow = () => {
    const userData = app.getPath('userData');
    const bounds = readWindowState(userData);
    const next = new BrowserWindow({
      ...(bounds.x === undefined || bounds.y === undefined
        ? {}
        : { x: bounds.x, y: bounds.y }),
      width: bounds.width,
      height: bounds.height,
      minWidth: MIN_WINDOW_WIDTH,
      minHeight: MIN_WINDOW_HEIGHT,
      title: 'Nesvo',
      icon: appIcon,
      backgroundColor: windowColors().background,
      show: !smokeTest,
      autoHideMenuBar: true,
      ...titleBarOptions(process.platform),
      webPreferences: {
        preload: join(import.meta.dirname, '../preload/index.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        backgroundThrottling: !smokeTest,
        additionalArguments: [`--nesvo-color-scheme=${appliedColorScheme()}`],
      },
    });
    window = next;
    if (bounds.maximized && !smokeTest) next.maximize();
    next.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    next.webContents.on('will-navigate', event => event.preventDefault());
    next.webContents.on('will-redirect', event => event.preventDefault());
    next.webContents.on('will-frame-navigate', event => event.preventDefault());
    next.webContents.session.setPermissionRequestHandler(
      (_contents, permission, callback) =>
        callback(
          permission === 'notifications' ||
            permission === 'clipboard-sanitized-write',
        ),
    );
    next.webContents.session.setPermissionCheckHandler(
      (_contents, permission) =>
        permission === 'notifications' ||
        permission === 'clipboard-sanitized-write',
    );
    let rendererCrashes: number[] = [];
    next.webContents.on('render-process-gone', (_event, details) => {
      log.error(
        `The window renderer stopped: ${details.reason} (exit code ${details.exitCode}).`,
      );
      if (details.reason === 'clean-exit' || quitting || next.isDestroyed())
        return;
      const now = Date.now();
      rendererCrashes = [
        ...rendererCrashes.filter(
          time => now - time < RENDERER_CRASH_WINDOW_MS,
        ),
        now,
      ];
      if (rendererCrashes.length > MAX_RENDERER_RELOADS_PER_WINDOW) {
        log.error('The window renderer keeps stopping; reloading is paused.');
        rendererCrashes = [];
        void offerRecovery(next);
        return;
      }
      loadRenderer(next);
    });
    next.webContents.on('unresponsive', () =>
      log.warn('The window stopped responding.'),
    );
    next.webContents.on('responsive', () =>
      log.info('The window is responding again.'),
    );
    next.webContents.on('preload-error', (_event, path, error) =>
      log.error(`The preload script failed: ${path}.`, error),
    );
    next.on('focus', () => next.flashFrame(false));
    next.on('close', () => saveWindowState(userData, next));
    const applyColors = () => {
      if (next.isDestroyed()) return;
      next.setBackgroundColor(windowColors().background);
      next.webContents.send('nesvo:applied-color-scheme', appliedColorScheme());
      if (process.platform !== 'darwin')
        next.setTitleBarOverlay(titleBarOverlay());
    };
    nativeTheme.on('updated', applyColors);
    next.on('closed', () => {
      nativeTheme.off('updated', applyColors);
      if (window === next) window = null;
    });
    loadRenderer(next);
  };
  const authorize = (
    event: Electron.IpcMainInvokeEvent | Electron.IpcMainEvent,
  ) => {
    if (
      !window ||
      event.sender !== window.webContents ||
      event.senderFrame !== window.webContents.mainFrame
    ) {
      throw new Error('Unauthorized caller');
    }
  };
  const send = (event: WorkspaceEvent) => {
    if (window && !window.isDestroyed())
      window.webContents.send('nesvo:event', event);
  };
  const workflowDemo: WorkflowDemo | null = isWorkflowDemoEnabled(
    app.isPackaged,
  )
    ? createWorkflowDemo({
        directory:
          process.env.NESVO_WORKFLOW_DEMO_DIRECTORY || app.getPath('userData'),
        publish: send,
      })
    : null;
  const withDemoSessions = (
    sessions: DesktopSession[],
    hostId: string | undefined,
  ) =>
    workflowDemo && (!hostId || hostId === 'local')
      ? [...sessions, ...workflowDemo.sessions()]
      : sessions;
  computers.subscribe(event =>
    send(
      event.type === 'host-snapshot'
        ? { ...event, sessions: withDemoSessions(event.sessions, event.hostId) }
        : event,
    ),
  );
  handle('nesvo:color-scheme', event => {
    authorize(event);
    return nativeTheme.themeSource;
  });
  handle('nesvo:applied-color-scheme', event => {
    authorize(event);
    return appliedColorScheme();
  });
  handle('nesvo:set-color-scheme', (event, scheme: unknown) => {
    authorize(event);
    const next = colorSchemeSchema.parse(scheme);
    saveColorScheme(app.getPath('userData'), next);
    nativeTheme.themeSource = next;
    window?.webContents.send(
      'nesvo:applied-color-scheme',
      appliedColorScheme(),
    );
    return next;
  });
  handle('nesvo:open-external', async (event, url: unknown) => {
    authorize(event);
    if (typeof url !== 'string') throw new Error('Invalid link');
    if (url.length > MAX_EXTERNAL_URL_LENGTH) throw new Error('Invalid link');
    let target: URL;
    try {
      target = new URL(url);
    } catch {
      throw new Error('Invalid link');
    }
    if (target.protocol !== 'http:' && target.protocol !== 'https:') {
      throw new Error('Unsupported link protocol');
    }
    await shell.openExternal(target.href);
  });
  handle('nesvo:open-logs', async event => {
    authorize(event);
    mkdirSync(logsDirectory(), { recursive: true });
    const failure = await shell.openPath(logsDirectory());
    if (failure) throw new Error('The logs folder could not be opened.');
  });
  handle('nesvo:focus-window', event => {
    authorize(event);
    if (!window || window.isDestroyed() || smokeTest) return;
    if (window.isMinimized()) window.restore();
    window.show();
    if (process.platform === 'darwin') app.focus({ steal: true });
    window.focus();
  });
  handle('nesvo:request-attention', event => {
    authorize(event);
    if (!window || window.isDestroyed() || window.isFocused()) return;
    window.flashFrame(true);
  });
  let errorReports: number[] = [];
  ipcMain.on('nesvo:report-error', (event, payload: unknown) => {
    try {
      authorize(event);
    } catch {
      return;
    }
    const now = Date.now();
    errorReports = errorReports.filter(
      time => now - time < ERROR_REPORT_WINDOW_MS,
    );
    if (errorReports.length >= MAX_ERROR_REPORTS_PER_WINDOW) return;
    errorReports.push(now);
    let size = Number.POSITIVE_INFINITY;
    try {
      size = Buffer.byteLength(JSON.stringify(payload) ?? '');
    } catch {
      size = Number.POSITIVE_INFINITY;
    }
    if (size > MAX_RENDERER_ERROR_REPORT_BYTES) {
      log.warn('The window sent an oversized error report.');
      return;
    }
    const report = rendererErrorReportSchema.safeParse(payload);
    if (!report.success) {
      log.warn('The window sent an invalid error report.');
      return;
    }
    const { kind, message, stack, componentStack } = report.data;
    log.error(
      `Window ${kind}: ${message}`,
      [stack, componentStack].filter(Boolean).join('\n'),
    );
  });
  handle('nesvo:mobile-status', event => {
    authorize(event);
    return mobile.status();
  });
  handle('nesvo:enable-mobile', event => {
    authorize(event);
    return mobile.enable();
  });
  handle('nesvo:disable-mobile', event => {
    authorize(event);
    return mobile.disable();
  });
  handle('nesvo:pair-mobile', event => {
    authorize(event);
    return mobile.pair();
  });
  handle('nesvo:revoke-mobile', (event, deviceId: unknown) => {
    authorize(event);
    return mobile.revoke(mobileDeviceSchema.shape.id.parse(deviceId));
  });
  handle('nesvo:list-computers', event => {
    authorize(event);
    return computers.listComputers();
  });
  handle('nesvo:add-computer', (event, input: unknown) => {
    authorize(event);
    return computers.addComputer(sshComputerInputSchema.parse(input));
  });
  handle('nesvo:connect-computer', (event, hostId: unknown) => {
    authorize(event);
    return computers.connectComputer(hostIdSchema.parse(hostId));
  });
  handle('nesvo:disconnect-computer', (event, hostId: unknown) => {
    authorize(event);
    return computers.disconnectComputer(hostIdSchema.parse(hostId));
  });
  handle('nesvo:remove-computer', (event, hostId: unknown) => {
    authorize(event);
    return computers.removeComputer(hostIdSchema.parse(hostId));
  });
  const route = (hostId: unknown) => hostIdSchema.parse(hostId ?? 'local');
  handle('nesvo:about', event => {
    authorize(event);
    return aboutInfo(hostDirectory);
  });
  handle('nesvo:show-data-directory', event => {
    authorize(event);
    shell.showItemInFolder(app.getPath('userData'));
  });
  handle('nesvo:show-backup', (event, path: unknown) => {
    authorize(event);
    showBackup(hostDirectory, path);
  });
  handle('nesvo:open-licenses', async event => {
    authorize(event);
    await openLicenses();
  });
  handle('nesvo:save-text-file', (event, input: unknown) => {
    authorize(event);
    return saveTextFile(window, input);
  });
  handle('nesvo:backup-database', (event, hostId: unknown) => {
    authorize(event);
    return computers.execute('backup-database', undefined, route(hostId));
  });
  handle('nesvo:list-cost-budgets', (event, hostId: unknown) => {
    authorize(event);
    return computers.execute('list-cost-budgets', undefined, route(hostId));
  });
  const costCommands = {
    'read-costs': readCostsSchema,
    'create-cost-budget': createCostBudgetSchema,
    'update-cost-budget': costBudgetSchema,
    'delete-cost-budget': deleteCostBudgetSchema,
  } as const;
  for (const method of Object.keys(costCommands) as Array<
    keyof typeof costCommands
  >) {
    handle(`nesvo:${method}`, (event, input: unknown, hostId: unknown) => {
      authorize(event);
      return computers.execute(
        method,
        costCommands[method].parse(input),
        route(hostId),
      );
    });
  }
  handle('nesvo:provider-usage', (event, input: unknown, hostId: unknown) => {
    authorize(event);
    return computers.execute(
      'provider-usage',
      providerUsageInputSchema.parse(input),
      route(hostId),
    );
  });
  handle('nesvo:health', async (event, hostId: unknown) => {
    authorize(event);
    return computers.execute('health', undefined, route(hostId));
  });
  handle('nesvo:claude-status', async (event, hostId: unknown) => {
    authorize(event);
    return computers.execute('claude-status', undefined, route(hostId));
  });
  handle('nesvo:codex-status', async (event, hostId: unknown) => {
    authorize(event);
    return computers.execute('codex-status', undefined, route(hostId));
  });
  handle(
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
  handle(
    'nesvo:decide-worker-plan',
    async (event, input: unknown, hostId: unknown) => {
      authorize(event);
      return computers.execute(
        'decide-worker-plan',
        decideWorkerPlanSchema.parse(input),
        route(hostId),
      );
    },
  );
  handle(
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
  handle('nesvo:list-sessions', async (event, hostId: unknown) => {
    authorize(event);
    const id = hostIdSchema.optional().parse(hostId);
    return withDemoSessions(computers.listSessions(id), id);
  });
  handle(
    'nesvo:get-session',
    async (event, input: unknown, hostId: unknown) => {
      authorize(event);
      const parsed = getSessionSchema.parse(input);
      const target = route(hostId);
      const demo =
        target === 'local'
          ? workflowDemo
              ?.sessions()
              .find(session => session.id === parsed.sessionId)
          : undefined;
      return demo ?? computers.getSession(parsed, target);
    },
  );
  handle(
    'nesvo:read-session-messages',
    async (event, input: unknown, hostId: unknown) => {
      authorize(event);
      return computers.readSessionMessages(
        readSessionMessagesSchema.parse(input),
        route(hostId),
      );
    },
  );
  handle('nesvo:list-reviews', async (event, hostId: unknown) => {
    authorize(event);
    return computers.listReviews(hostIdSchema.optional().parse(hostId));
  });
  handle(
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
  handle(
    'nesvo:list-pull-requests',
    async (event, input: unknown, hostId: unknown) => {
      authorize(event);
      return computers.execute(
        'list-pull-requests',
        listPullRequestsSchema.parse(input),
        route(hostId),
      );
    },
  );
  handle(
    'nesvo:read-pull-request',
    async (event, input: unknown, hostId: unknown) => {
      authorize(event);
      return computers.execute(
        'read-pull-request',
        readPullRequestSchema.parse(input),
        route(hostId),
      );
    },
  );
  handle(
    'nesvo:read-pull-request-files',
    async (event, input: unknown, hostId: unknown) => {
      authorize(event);
      return computers.execute(
        'read-pull-request-files',
        readPullRequestSchema.parse(input),
        route(hostId),
      );
    },
  );
  handle(
    'nesvo:read-pull-request-threads',
    async (event, input: unknown, hostId: unknown) => {
      authorize(event);
      return computers.execute(
        'read-pull-request-threads',
        readPullRequestSchema.parse(input),
        route(hostId),
      );
    },
  );
  handle(
    'nesvo:act-on-pull-request',
    async (event, input: unknown, hostId: unknown) => {
      authorize(event);
      return computers.execute(
        'act-on-pull-request',
        actOnPullRequestSchema.parse(input),
        route(hostId),
      );
    },
  );
  handle(
    'nesvo:link-session-pull-request',
    async (event, input: unknown, hostId: unknown) => {
      authorize(event);
      return computers.execute(
        'link-session-pull-request',
        linkSessionPullRequestSchema.parse(input),
        route(hostId),
      );
    },
  );
  handle(
    'nesvo:find-session-pull-request',
    async (event, input: unknown, hostId: unknown) => {
      authorize(event);
      return computers.execute(
        'find-session-pull-request',
        findSessionPullRequestSchema.parse(input),
        route(hostId),
      );
    },
  );
  handle('nesvo:list-conversations', async (event, hostId: unknown) => {
    authorize(event);
    return computers.execute('list-conversations', undefined, route(hostId));
  });
  handle(
    'nesvo:adopt-conversation',
    async (event, input: unknown, hostId: unknown) => {
      authorize(event);
      return computers.execute(
        'adopt-conversation',
        adoptConversationSchema.parse(input),
        route(hostId),
      );
    },
  );
  handle(
    'nesvo:search-history',
    async (event, input: unknown, hostId: unknown) => {
      authorize(event);
      return computers.execute(
        'search-history',
        historySearchInputSchema.parse(input),
        route(hostId),
      );
    },
  );
  handle(
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
  handle(
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
  handle(
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
  handle(
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
  handle(
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
  handle('nesvo:list-scheduled-jobs', (event, hostId: unknown) => {
    authorize(event);
    return computers.executeScheduledJob(
      'list-scheduled-jobs',
      listScheduledJobsSchema.parse({}),
      hostIdSchema.parse(hostId),
    );
  });
  handle(
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
  handle(
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
  handle(
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
  handle(
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
  handle(
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
  handle(
    'nesvo:decide-scheduled-job-start',
    (event, input: unknown, hostId: unknown) => {
      authorize(event);
      return computers.executeScheduledJob(
        'decide-scheduled-job-start',
        decideScheduledJobStartSchema.parse(input),
        hostIdSchema.parse(hostId),
      );
    },
  );
  for (const method of Object.keys(workflowInputs) as CatalogWorkflowMethod[])
    handle(`nesvo:${method}`, (event, input: unknown, hostId: unknown) => {
      authorize(event);
      const parsed = workflowInputs[method].parse(input);
      const target = hostIdSchema.parse(hostId);
      return workflowDemo?.serves(method, parsed, target)
        ? workflowDemo.execute(method, parsed)
        : computers.executeWorkflow(method, parsed, target);
    });
  handle(
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
  handle(
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
  handle(
    'nesvo:read-session-worktree',
    async (event, input: unknown, hostId: unknown) => {
      authorize(event);
      return computers.execute(
        'read-session-worktree',
        readSessionWorktreeSchema.parse(input),
        route(hostId),
      );
    },
  );
  handle(
    'nesvo:finish-session-worktree',
    async (event, input: unknown, hostId: unknown) => {
      authorize(event);
      return computers.execute(
        'finish-session-worktree',
        finishSessionWorktreeSchema.parse(input),
        route(hostId),
      );
    },
  );
  handle(
    'nesvo:read-session-worktree-setup',
    (event, input: unknown, hostId: unknown) => {
      authorize(event);
      return computers.execute(
        'read-session-worktree-setup',
        readSessionWorktreeSchema.parse(input),
        route(hostId),
      );
    },
  );
  handle(
    'nesvo:run-session-worktree-setup',
    (event, input: unknown, hostId: unknown) => {
      authorize(event);
      return computers.execute(
        'run-session-worktree-setup',
        runSessionWorktreeSetupSchema.parse(input),
        route(hostId),
      );
    },
  );
  handle('nesvo:list-orphaned-session-worktrees', (event, hostId: unknown) => {
    authorize(event);
    return computers.execute(
      'list-orphaned-session-worktrees',
      undefined,
      route(hostId),
    );
  });
  handle(
    'nesvo:remove-orphaned-session-worktree',
    (event, input: unknown, hostId: unknown) => {
      authorize(event);
      return computers.execute(
        'remove-orphaned-session-worktree',
        removeOrphanedSessionWorktreeSchema.parse(input),
        route(hostId),
      );
    },
  );
  handle(
    'nesvo:list-mcp-servers',
    async (event, input: unknown, hostId: unknown) => {
      authorize(event);
      return computers.execute(
        'list-mcp-servers',
        listMcpServersSchema.parse(input),
        route(hostId),
      );
    },
  );
  handle(
    'nesvo:set-session-mcp',
    async (event, input: unknown, hostId: unknown) => {
      authorize(event);
      return computers.execute(
        'set-session-mcp',
        setSessionMcpSchema.parse(input),
        route(hostId),
      );
    },
  );
  handle(
    'nesvo:assign-session-workflow',
    async (event, input: unknown, hostId: unknown) => {
      authorize(event);
      return computers.execute(
        'assign-session-workflow',
        assignSessionWorkflowSchema.parse(input),
        route(hostId),
      );
    },
  );
  handle('nesvo:list-session-groups', async (event, hostId: unknown) => {
    authorize(event);
    return computers.execute('list-session-groups', undefined, route(hostId));
  });
  const sessionThreadInputs = {
    'fork-session': forkSessionSchema,
    'restart-session': restartSessionSchema,
  } as const;
  for (const method of ['fork-session', 'restart-session'] as const) {
    handle(
      `nesvo:${method}`,
      async (event, input: unknown, hostId: unknown) => {
        authorize(event);
        return computers.execute(
          method,
          sessionThreadInputs[method].parse(input),
          route(hostId),
        );
      },
    );
  }
  const sessionGroupInputs = {
    'create-session-group': createSessionGroupSchema,
    'update-session-group': updateSessionGroupSchema,
    'move-session-group': moveSessionGroupSchema,
    'delete-session-group': deleteSessionGroupSchema,
    'move-session': moveSessionSchema,
    'rename-session': renameSessionSchema,
    'set-session-pinned': setSessionPinnedSchema,
    'set-session-archived': setSessionArchivedSchema,
  } as const;
  for (const method of Object.keys(
    sessionGroupInputs,
  ) as (keyof typeof sessionGroupInputs)[])
    handle(
      `nesvo:${method}`,
      async (event, input: unknown, hostId: unknown) => {
        authorize(event);
        return computers.execute(
          method,
          sessionGroupInputs[method].parse(input),
          route(hostId),
        );
      },
    );
  handle(
    'nesvo:queue-message',
    async (event, input: unknown, hostId: unknown) => {
      authorize(event);
      return computers.execute(
        'queue-message',
        sendMessageSchema.parse(input),
        route(hostId),
      );
    },
  );
  handle(
    'nesvo:cancel-queued',
    async (event, input: unknown, hostId: unknown) => {
      authorize(event);
      return computers.execute(
        'cancel-queued',
        queuedMessageRefSchema.parse(input),
        route(hostId),
      );
    },
  );
  handle(
    'nesvo:start-queued',
    async (event, input: unknown, hostId: unknown) => {
      authorize(event);
      return computers.execute(
        'start-queued',
        queuedMessageRefSchema.parse(input),
        route(hostId),
      );
    },
  );
  handle('nesvo:stop-run', async (event, input: unknown, hostId: unknown) => {
    authorize(event);
    return computers.execute(
      'stop-run',
      stopRunSchema.parse(input),
      route(hostId),
    );
  });
  createWindow();
  void computers
    .initialize()
    .catch(error => log.error('Computers could not be initialized.', error));
  powerMonitor.on('resume', () => computers.resume());
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
