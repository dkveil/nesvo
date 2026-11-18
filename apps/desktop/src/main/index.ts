import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { app, BrowserWindow, ipcMain, nativeTheme, shell } from 'electron';
import appIcon from '../../build/icons/256x256.png?asset';
import { startHost } from './host-client';
import {
  ComputerManager,
  type CatalogWorkflowMethod,
} from './computer-manager';
import { mobileAccess } from './mobile-access';
import { readColorScheme, saveColorScheme } from './appearance-store';
import {
  createWorkflowDemo,
  isWorkflowDemoEnabled,
  type WorkflowDemo,
} from './workflow-demo';
import {
  colorSchemeSchema,
  createSessionSchema,
  decideDelegationSchema,
  decideWorkerPlanSchema,
  decideReviewSchema,
  respondApprovalSchema,
  assignSessionWorkflowSchema,
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
const smokeTest = process.env.NESVO_SMOKE_TEST === '1';
if (process.env.NESVO_DATA_DIR)
  app.setPath('userData', process.env.NESVO_DATA_DIR);

const ownsInstance = app.requestSingleInstanceLock();
if (!ownsInstance) app.quit();
void app.whenReady().then(async () => {
  if (!ownsInstance) return;
  app.setAppUserModelId('app.nesvo.desktop');
  nativeTheme.themeSource = readColorScheme(app.getPath('userData'));
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
    next.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    next.webContents.on('will-navigate', event => event.preventDefault());
    next.webContents.session.setPermissionRequestHandler(
      (_contents, permission, callback) =>
        callback(permission === 'notifications'),
    );
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
  ipcMain.handle('nesvo:color-scheme', event => {
    authorize(event);
    return nativeTheme.themeSource;
  });
  ipcMain.handle('nesvo:applied-color-scheme', event => {
    authorize(event);
    return appliedColorScheme();
  });
  ipcMain.handle('nesvo:set-color-scheme', (event, scheme: unknown) => {
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
  ipcMain.handle('nesvo:open-external', async (event, url: unknown) => {
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
  ipcMain.handle('nesvo:list-cost-budgets', (event, hostId: unknown) => {
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
    ipcMain.handle(
      `nesvo:${method}`,
      (event, input: unknown, hostId: unknown) => {
        authorize(event);
        return computers.execute(
          method,
          costCommands[method].parse(input),
          route(hostId),
        );
      },
    );
  }
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
    const id = hostIdSchema.optional().parse(hostId);
    return withDemoSessions(computers.listSessions(id), id);
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
  ipcMain.handle(
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
  ipcMain.handle(
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
  ipcMain.handle(
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
  ipcMain.handle(
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
  ipcMain.handle(
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
  ipcMain.handle(
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
  ipcMain.handle('nesvo:list-conversations', async (event, hostId: unknown) => {
    authorize(event);
    return computers.execute('list-conversations', undefined, route(hostId));
  });
  ipcMain.handle(
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
  ipcMain.handle(
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
  for (const method of Object.keys(workflowInputs) as CatalogWorkflowMethod[])
    ipcMain.handle(
      `nesvo:${method}`,
      (event, input: unknown, hostId: unknown) => {
        authorize(event);
        const parsed = workflowInputs[method].parse(input);
        const target = hostIdSchema.parse(hostId);
        return workflowDemo?.serves(method, parsed, target)
          ? workflowDemo.execute(method, parsed)
          : computers.executeWorkflow(method, parsed, target);
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
  ipcMain.handle(
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
  ipcMain.handle(
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
  ipcMain.handle(
    'nesvo:list-session-groups',
    async (event, hostId: unknown) => {
      authorize(event);
      return computers.execute('list-session-groups', undefined, route(hostId));
    },
  );
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
    ipcMain.handle(
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
  ipcMain.handle(
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
  ipcMain.handle(
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
  ipcMain.handle(
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
