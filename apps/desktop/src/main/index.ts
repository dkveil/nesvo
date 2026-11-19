import { installTestCommandAudit } from '@nesvo/host';
import { deleteLocalData } from './delete-local-data';
import {
  deleteLocalDataPhrase,
  retentionDaysSchema,
  runningAppQuerySchema,
} from '@nesvo/contracts';
import { workLaptopPolicy } from './work-laptop-policy';
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
import trayIcon from '../../build/icons/32x32.png?asset';
import { AttentionIndicators } from './attention-indicators';
import {
  readKeepRunningInBackground,
  saveKeepRunningInBackground,
} from './background-store';
import { startHost } from './host-client';
import { stopLogging, initializeLogging, log, logsDirectory } from './logging';
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
import { launchMcpTerminal, launchTerminal } from './session-terminal';
import { aboutInfo, openLicenses, saveTextFile, showBackup } from './app-files';
import { openAttachmentFile } from './attachment-files';
import { inboxCliInstallation } from './external-inbox-cli';
import {
  configurationDecisionSchema,
  configurationEnrollSchema,
  configurationHistoryInputSchema,
  configurationInspectDraftSchema,
  configurationInboxLookupSchema,
  configurationInboxSendSchema,
  configurationProfileInputSchema,
  configurationProfileSchema,
  configurationUndoSchema,
  type ConfigurationProfile,
} from '@nesvo/contracts';
import { readColorScheme, saveColorScheme } from './appearance-store';
import { findImportLink, SHARE_PROTOCOL } from './share-link';
import { createWorkflowSharing } from './workflow-sharing';
import {
  createWorkflowDemo,
  isWorkflowDemoEnabled,
  type WorkflowDemo,
} from './workflow-demo';
import {
  colorSchemeSchema,
  desktopAttentionSchema,
  keepRunningInBackgroundSchema,
  createSessionSchema,
  readSessionWorktreeSchema,
  finishSessionWorktreeSchema,
  runSessionWorktreeSetupSchema,
  removeOrphanedSessionWorktreeSchema,
  decideDelegationSchema,
  decideWorkerPlanSchema,
  decideSessionParentSchema,
  workerWorktreeInputSchema,
  continueCoordinatorSchema,
  continueWorkerSchema,
  decideSessionPlanSchema,
  decideInboxItemSchema,
  externalInboxDeviceIdSchema,
  externalInboxDeviceNameSchema,
  deleteInboxRuleSchema,
  inboxSettingsSchema,
  listInboxRulesSchema,
  proposeInboxRuleSchema,
  saveInboxRuleSchema,
  setInboxRuleEnabledSchema,
  validateInboxRuleSchema,
  answerSessionQuestionSchema,
  coordinatorPolicySchema,
  decideReviewSchema,
  respondApprovalSchema,
  getSessionSchema,
  readSessionMessagesSchema,
  assignSessionWorkflowSchema,
  forkSessionSchema,
  restartSessionSchema,
  resumeSessionSchema,
  readMergedWorktreeCleanupSchema,
  finishMergedWorktreeSchema,
  compactSessionSchema,
  createSessionGroupSchema,
  deleteSessionGroupSchema,
  moveSessionGroupSchema,
  moveSessionSchema,
  renameSessionSchema,
  setSessionArchivedSchema,
  deleteSessionSchema,
  restoreSessionSchema,
  setSessionPinnedSchema,
  updateSessionGroupSchema,
  sendMessageSchema,
  queuedMessageRefSchema,
  stopRunSchema,
  listWorkspaceDirectorySchema,
  searchWorkspaceFilesSchema,
  readWorkspaceFileSchema,
  readSessionChangesSchema,
  readSessionChangePatchSchema,
  readAttachmentSchema,
  openAttachmentSchema,
  attachmentLocationSchema,
  stageAttachmentSchema,
  readGitBranchSchema,
  historySearchInputSchema,
  openSessionTerminalSchema,
  setSessionTerminalSchema,
  terminalResume,
  transcriptSearchInputSchema,
  adoptConversationSchema,
  adoptManagerImportSchema,
  listManagerImportSchema,
  createProviderProfileSchema,
  renameProviderProfileSchema,
  removeProviderProfileSchema,
  providerProfileListSchema,
  providerProfileSelectionSchema,
  listConversationsSchema,
  listPullRequestsSchema,
  addTrackedRepositorySchema,
  saveWorktreeRecipeSchema,
  deleteWorktreeRecipeSchema,
  matchWorktreeRecipeSchema,
  startWorktreeRecipeTrialSchema,
  worktreeRecipeTrialRefSchema,
  readSessionWorktreeRecipeSchema,
  decideSessionWorktreeRecipeSchema,
  removeTrackedRepositorySchema,
  setDefaultSessionFolderSchema,
  claudeAutonomyInputSchema,
  reorderTrackedRepositoriesSchema,
  listTrackedPullRequestsSchema,
  readPullRequestSchema,
  saveReviewerProfileSchema,
  deleteReviewerProfileSchema,
  saveReviewConventionSchema,
  deleteReviewConventionSchema,
  lessonSettingsSchema,
  gateRulesInputSchema,
  proposeLessonsSchema,
  decideLessonSchema,
  startPullRequestReviewSchema,
  listPullRequestReviewsSchema,
  updateReviewFindingSchema,
  discardPullRequestReviewSchema,
  publishPullRequestReviewSchema,
  actOnPullRequestSchema,
  linkSessionPullRequestSchema,
  findSessionPullRequestSchema,
  discoverSkillsSchema,
  listClaudeCommandsSchema,
  listMcpServersSchema,
  mcpConnectionRequestSchema,
  mcpProfileTargetSchema,
  trustRepositoryMcpSchema,
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
  chooseDirectoryResultSchema,
  onboardingOpenSchema,
  reviewWorkingRulesSchema,
  MAX_RENDERER_ERROR_REPORT_BYTES,
  rendererErrorReportSchema,
  workflowShareSettingsSchema,
  type AppliedColorScheme,
  type DesktopSession,
  type WorkspaceEvent,
} from '@nesvo/contracts';

app.setName('Nesvo');
nativeTheme.themeSource = 'system';
const TITLE_BAR_HEIGHT = 40;
const appliedColorScheme = (): AppliedColorScheme =>
  nativeTheme.shouldUseDarkColors ? 'dark' : 'light';
const windowColors = (onboarding = false) =>
  onboarding || nativeTheme.shouldUseDarkColors
    ? { background: '#000000', symbol: '#f8fafc' }
    : { background: '#fcfcfc', symbol: '#1f2937' };
const titleBarOverlay = (onboarding = false): Electron.TitleBarOverlay => ({
  color: '#01000000',
  symbolColor: windowColors(onboarding).symbol,
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
    : { titleBarStyle: 'hidden', titleBarOverlay: titleBarOverlay(true) };
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
installTestCommandAudit();
const smokeTest = process.env.NESVO_SMOKE_TEST === '1';
const terminalLaunchLog = app.isPackaged
  ? undefined
  : process.env.NESVO_TERMINAL_LAUNCH_LOG;
if (process.env.NESVO_DATA_DIR) {
  app.setPath('userData', process.env.NESVO_DATA_DIR);
  app.setAppLogsPath(join(process.env.NESVO_DATA_DIR, 'logs'));
}
initializeLogging(app.getPath('logs'), !app.isPackaged);
process.on('uncaughtException', () =>
  log.error('Uncaught exception in the main process.'),
);
process.on('unhandledRejection', () =>
  log.error('Unhandled promise rejection in the main process.'),
);
app.on('child-process-gone', (_event, details) =>
  log.error(
    `A ${details.type} process stopped: ${details.reason} (exit code ${details.exitCode}).`,
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
    log.warn(`${channel} received invalid data.`);
    return new Error(
      'Nesvo received invalid data for this action. Reload the window and try again.',
    );
  }
  log.warn(`${channel} failed.`);
  return error instanceof Error ? error : new Error('The action failed.');
};

const handle = (
  channel: string,
  listener: (event: Electron.IpcMainInvokeEvent, ...args: unknown[]) => unknown,
) =>
  ipcMain.handle(channel, async (event, ...args: unknown[]) => {
    try {
      return { ok: true, value: await listener(event, ...args) };
    } catch (error) {
      return { ok: false, message: describeIpcFailure(channel, error).message };
    }
  });

const ownsInstance = app.requestSingleInstanceLock();
if (!ownsInstance) app.quit();
const pendingImportLinks: string[] = [];
let deliverImportLink = (link: string) => {
  pendingImportLinks.push(link);
};
const launchLink = findImportLink(process.argv);
if (launchLink) pendingImportLinks.push(launchLink);
app.on('open-url', (event, url) => {
  event.preventDefault();
  deliverImportLink(url);
});
if (ownsInstance && app.isPackaged && !smokeTest)
  app.setAsDefaultProtocolClient(SHARE_PROTOCOL);
void app.whenReady().then(async () => {
  if (!ownsInstance) return;
  app.setAppUserModelId('app.nesvo.desktop');
  log.info(`Nesvo ${app.getVersion()} started.`);
  applyApplicationMenu();
  nativeTheme.themeSource = readColorScheme(app.getPath('userData'));
  const hostDirectory = join(app.getPath('userData'), 'host');
  const policy = await workLaptopPolicy(app.getPath('userData'));
  const startLocalHost = () => {
    const host = startHost(hostDirectory, policy.enabled);
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
    policy.enabled,
  );
  const mobile = mobileAccess(
    app.getPath('userData'),
    computers,
    policy.enabled,
  );
  let window: BrowserWindow | null = null;
  let onboardingOpen = false;
  const applyWindowColors = (target: BrowserWindow) => {
    target.setBackgroundColor(windowColors(onboardingOpen).background);
    if (process.platform !== 'darwin')
      target.setTitleBarOverlay(titleBarOverlay(onboardingOpen));
  };
  let quitting = false;
  let erasing = false;
  let keepRunning = readKeepRunningInBackground(app.getPath('userData'));
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
    onboardingOpen = false;
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
      backgroundColor: windowColors(true).background,
      show: !smokeTest,
      autoHideMenuBar: true,
      ...titleBarOptions(process.platform),
      webPreferences: {
        preload: join(import.meta.dirname, '../preload/index.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        backgroundThrottling: !smokeTest,
        additionalArguments: [
          `--nesvo-color-scheme=${appliedColorScheme()}`,
          ...(process.env.NESVO_TEST_MODE === '1' &&
          process.env.NESVO_TEST_SHOW_ONBOARDING !== '1'
            ? ['--nesvo-onboarding=skip']
            : []),
        ],
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
    next.webContents.on('preload-error', () =>
      log.error('The preload script failed.'),
    );
    next.on('focus', () => next.flashFrame(false));
    next.on('close', event => {
      if (!erasing) saveWindowState(userData, next);
      if (quitting || !keepRunning || smokeTest) return;
      event.preventDefault();
      next.hide();
    });
    next.on('show', () => indicators.refreshWindow());
    const applyColors = () => {
      if (next.isDestroyed()) return;
      applyWindowColors(next);
      next.webContents.send('nesvo:applied-color-scheme', appliedColorScheme());
    };
    nativeTheme.on('updated', applyColors);
    next.on('closed', () => {
      nativeTheme.off('updated', applyColors);
      if (window === next) window = null;
    });
    loadRenderer(next);
  };
  const showWindow = () => {
    if (!window || window.isDestroyed()) createWindow();
    if (!window || smokeTest) return;
    if (window.isMinimized()) window.restore();
    window.show();
    if (process.platform === 'darwin') app.focus({ steal: true });
    window.focus();
  };
  const indicators = new AttentionIndicators({
    iconPath: trayIcon,
    window: () => window,
    show: showWindow,
    openSession: target => {
      showWindow();
      window?.webContents.send('nesvo:open-session', target);
    },
    quit: () => app.quit(),
  });
  const authorize = (
    event: Electron.IpcMainInvokeEvent | Electron.IpcMainEvent,
  ) => {
    if (erasing) throw new Error('Nesvo is deleting its local data.');
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
  const applyProfile = (profile: ConfigurationProfile) => {
    if (profile.colorScheme !== undefined) {
      saveColorScheme(app.getPath('userData'), profile.colorScheme);
      nativeTheme.themeSource = profile.colorScheme;
    }
    if (profile.keepRunning !== undefined) {
      keepRunning = profile.keepRunning;
      saveKeepRunningInBackground(app.getPath('userData'), keepRunning);
    }
  };
  const configProfile = async (input: unknown) => {
    const requested = configurationProfileInputSchema.parse(input);
    const request =
      requested.action === 'save'
        ? requested
        : {
            action: 'seed' as const,
            values: {
              colorScheme: nativeTheme.themeSource,
              keepRunning,
              ...requested.values,
            },
          };
    const profile = configurationProfileSchema.parse(
      await computers.execute(
        'desktop-configuration-profile',
        request,
        'local',
      ),
    );
    applyProfile(profile);
    return profile;
  };
  computers.subscribe(event => {
    send(
      event.type === 'host-snapshot'
        ? { ...event, sessions: withDemoSessions(event.sessions, event.hostId) }
        : event,
    );
    if (event.type === 'host-snapshot' && event.hostId === 'local') {
      void configProfile({
        action: 'seed',
        values: { colorScheme: nativeTheme.themeSource, keepRunning },
      }).catch(() => undefined);
    }
    if (event.type === 'configuration-changed' && event.hostId === 'local')
      void configProfile({ action: 'read' }).catch(() => undefined);
  });
  handle('nesvo:desktop-configuration-profile', (event, input: unknown) => {
    authorize(event);
    return configProfile(input);
  });
  handle('nesvo:color-scheme', event => {
    authorize(event);
    return nativeTheme.themeSource;
  });
  handle('nesvo:applied-color-scheme', event => {
    authorize(event);
    return appliedColorScheme();
  });
  handle('nesvo:set-color-scheme', async (event, scheme: unknown) => {
    authorize(event);
    const next = colorSchemeSchema.parse(scheme);
    await configProfile({ action: 'save', values: { colorScheme: next } });
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
  handle('nesvo:set-attention', (event, attention: unknown) => {
    authorize(event);
    const state = desktopAttentionSchema.parse(attention);
    if (policy.enabled)
      state.sessions = state.sessions.map(item => ({
        ...item,
        title: 'Session needs attention',
      }));
    indicators.update(state);
  });
  handle('nesvo:keep-running-in-background', event => {
    authorize(event);
    return keepRunning;
  });
  handle(
    'nesvo:set-keep-running-in-background',
    async (event, enabled: unknown) => {
      authorize(event);
      const next = keepRunningInBackgroundSchema.parse(enabled);
      await configProfile({ action: 'save', values: { keepRunning: next } });
      return keepRunning;
    },
  );
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
    log.error(`Window reported a ${report.data.kind} error.`);
  });
  handle('nesvo:delete-local-data', (event, confirmation: unknown) => {
    authorize(event);
    if (confirmation !== deleteLocalDataPhrase)
      throw new Error('Enter the full confirmation to delete local data.');
    if (erasing || closing) throw new Error('Nesvo is already closing.');
    erasing = true;
    setImmediate(() => {
      void closeWorkspace()
        .then(async () => {
          const storage = window?.webContents.session;
          window?.destroy();
          await storage?.clearStorageData();
          await storage?.clearCache();
          stopLogging();
          await deleteLocalData(app.getPath('userData'), logsDirectory());
        })
        .catch(() => {
          if (smokeTest) {
            process.exitCode = 1;
            return;
          }
          dialog.showErrorBox(
            'Nesvo data could not be deleted',
            'Some local data may remain. Open Nesvo and try again.',
          );
        })
        .finally(() => {
          closed = true;
          app.quit();
        });
    });
  });
  handle('nesvo:get-transcript-retention', event => {
    authorize(event);
    return computers.execute('get-transcript-retention', undefined);
  });
  handle('nesvo:set-transcript-retention', (event, days: unknown) => {
    authorize(event);
    return computers.execute(
      'set-transcript-retention',
      retentionDaysSchema.parse(days),
    );
  });
  handle('nesvo:purge-transcripts', event => {
    authorize(event);
    return computers.execute('purge-transcripts', undefined);
  });
  handle('nesvo:work-laptop-policy', event => {
    authorize(event);
    return policy.status();
  });
  handle('nesvo:set-work-laptop-policy', (event, enabled: unknown) => {
    authorize(event);
    if (typeof enabled !== 'boolean')
      throw new Error('Invalid work laptop mode.');
    return policy.set(enabled);
  });
  const sharing = createWorkflowSharing({
    userData: app.getPath('userData'),
    appVersion: app.getVersion(),
    isPackaged: app.isPackaged,
    computers,
    onImportAvailable: () => {
      if (window && !window.isDestroyed())
        window.webContents.send('nesvo:workflow-import-available');
    },
  });
  handle('nesvo:share-settings', event => {
    authorize(event);
    return sharing.settings();
  });
  handle('nesvo:set-share-origin', (event, origin: unknown) => {
    authorize(event);
    return sharing.setOrigin(
      workflowShareSettingsSchema.shape.origin.nullable().parse(origin),
    );
  });
  handle(
    'nesvo:prepare-workflow-share',
    (event, hostId: unknown, input: unknown) => {
      authorize(event);
      return sharing.prepare(hostIdSchema.parse(hostId), input);
    },
  );
  handle('nesvo:upload-workflow-share', (event, draftId: unknown) => {
    authorize(event);
    return sharing.upload(draftId);
  });
  handle('nesvo:shared-workflow-links', event => {
    authorize(event);
    return sharing.links();
  });
  handle('nesvo:revoke-workflow-share', (event, id: unknown) => {
    authorize(event);
    return sharing.revoke(id);
  });
  handle('nesvo:forget-workflow-share', (event, id: unknown) => {
    authorize(event);
    return sharing.forget(id);
  });
  handle('nesvo:take-workflow-imports', event => {
    authorize(event);
    return sharing.takeImports();
  });
  handle('nesvo:import-workflow', (event, input: unknown) => {
    authorize(event);
    return sharing.importWorkflow(input);
  });
  handle('nesvo:dismiss-workflow-import', (event, importId: unknown) => {
    authorize(event);
    sharing.dismissImport(importId);
  });
  handle('nesvo:set-onboarding-open', (event, open: unknown) => {
    authorize(event);
    onboardingOpen = onboardingOpenSchema.parse(open);
    if (window && !window.isDestroyed()) applyWindowColors(window);
  });
  handle('nesvo:choose-directory', async event => {
    authorize(event);
    if (!window || window.isDestroyed()) return null;
    const result = await dialog.showOpenDialog(window, {
      title: 'Choose folder',
      properties: ['openDirectory', 'createDirectory'],
    });
    return chooseDirectoryResultSchema.parse(
      result.canceled ? null : (result.filePaths[0] ?? null),
    );
  });
  handle('nesvo:review-working-rules', (event, input: unknown) => {
    authorize(event);
    return computers.execute(
      'review-working-rules',
      reviewWorkingRulesSchema.parse(input),
      'local',
    );
  });
  handle('nesvo:pick-import-folder', async event => {
    authorize(event);
    if (!window || window.isDestroyed()) return null;
    const result = await dialog.showOpenDialog(window, {
      title: 'Choose a project folder',
      properties: ['openDirectory', 'createDirectory'],
    });
    return result.canceled ? null : (result.filePaths[0] ?? null);
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
  handle('nesvo:list-provider-profiles', (event, hostId: unknown) => {
    authorize(event);
    return computers.execute(
      'list-provider-profiles',
      undefined,
      route(hostId),
    );
  });
  const profileCommands = {
    'create-provider-profile': createProviderProfileSchema,
    'rename-provider-profile': renameProviderProfileSchema,
    'remove-provider-profile': removeProviderProfileSchema,
  } as const;
  for (const method of Object.keys(
    profileCommands,
  ) as (keyof typeof profileCommands)[]) {
    handle(`nesvo:${method}`, (event, input: unknown, hostId: unknown) => {
      authorize(event);
      return computers.execute(
        method,
        profileCommands[method].parse(input),
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
  handle(
    'nesvo:claude-status',
    async (event, hostId: unknown, input: unknown) => {
      authorize(event);
      return computers.execute(
        'claude-status',
        providerProfileSelectionSchema.optional().parse(input),
        route(hostId),
      );
    },
  );
  handle(
    'nesvo:codex-status',
    async (event, hostId: unknown, input: unknown) => {
      authorize(event);
      return computers.execute(
        'codex-status',
        providerProfileSelectionSchema.optional().parse(input),
        route(hostId),
      );
    },
  );
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
    'nesvo:list-claude-commands',
    async (event, input: unknown, hostId: unknown) => {
      authorize(event);
      return computers.execute(
        'list-claude-commands',
        listClaudeCommandsSchema.parse(input),
        route(hostId),
      );
    },
  );
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
    'nesvo:decide-session-parent',
    async (event, input: unknown, hostId: unknown) => {
      authorize(event);
      return computers.execute(
        'decide-session-parent',
        decideSessionParentSchema.parse(input),
        route(hostId),
      );
    },
  );
  handle(
    'nesvo:decide-session-plan',
    async (event, input: unknown, hostId: unknown) => {
      authorize(event);
      return computers.execute(
        'decide-session-plan',
        {
          ...decideSessionPlanSchema.parse(input),
          via:
            decideSessionPlanSchema.parse(input).via === 'parent'
              ? 'parent'
              : 'desktop',
        },
        route(hostId),
      );
    },
  );
  handle(
    'nesvo:answer-session-question',
    async (event, input: unknown, hostId: unknown) => {
      authorize(event);
      return computers.execute(
        'answer-session-question',
        {
          ...answerSessionQuestionSchema.parse(input),
          via:
            answerSessionQuestionSchema.parse(input).via === 'parent'
              ? 'parent'
              : 'desktop',
        },
        route(hostId),
      );
    },
  );
  handle('nesvo:gate-rules', (event, input: unknown, hostId: unknown) => {
    authorize(event);
    return computers.execute(
      'gate-rules',
      gateRulesInputSchema.parse(input),
      route(hostId),
    );
  });
  handle('nesvo:read-lessons', (event, hostId: unknown) => {
    authorize(event);
    return computers.execute('read-lessons', undefined, route(hostId));
  });
  const lessonCommands = {
    'save-lesson-settings': lessonSettingsSchema,
    'propose-lessons': proposeLessonsSchema,
    'decide-lesson': decideLessonSchema,
  } as const;
  for (const method of Object.keys(
    lessonCommands,
  ) as (keyof typeof lessonCommands)[]) {
    handle(`nesvo:${method}`, (event, input: unknown, hostId: unknown) => {
      authorize(event);
      return computers.execute(
        method,
        lessonCommands[method].parse(input),
        route(hostId),
      );
    });
  }
  handle('nesvo:worker-worktree', (event, input: unknown, hostId: unknown) => {
    authorize(event);
    return computers.execute(
      'worker-worktree',
      workerWorktreeInputSchema.parse(input),
      route(hostId),
    );
  });
  handle('nesvo:continue-worker', (event, input: unknown, hostId: unknown) => {
    authorize(event);
    return computers.execute(
      'continue-worker',
      continueWorkerSchema.parse(input),
      route(hostId),
    );
  });
  handle(
    'nesvo:continue-coordinator',
    (event, input: unknown, hostId: unknown) => {
      authorize(event);
      return computers.execute(
        'continue-coordinator',
        continueCoordinatorSchema.parse(input),
        route(hostId),
      );
    },
  );
  handle('nesvo:read-session-control-policy', (event, hostId: unknown) => {
    authorize(event);
    return computers.execute(
      'read-session-control-policy',
      undefined,
      route(hostId),
    );
  });
  handle(
    'nesvo:save-session-control-policy',
    (event, input: unknown, hostId: unknown) => {
      authorize(event);
      return computers.execute(
        'save-session-control-policy',
        coordinatorPolicySchema.parse(input),
        route(hostId),
      );
    },
  );
  const inboxRuleCalls = [
    [
      'nesvo:inspect-config-draft',
      'inspect-config-draft',
      configurationInspectDraftSchema,
    ],
    [
      'nesvo:lookup-inbox-assistant',
      'lookup-inbox-assistant',
      configurationInboxLookupSchema,
    ],
    [
      'nesvo:send-inbox-assistant',
      'send-inbox-assistant',
      configurationInboxSendSchema,
    ],
    [
      'nesvo:list-config-changes',
      'list-config-changes',
      configurationHistoryInputSchema,
    ],
    [
      'nesvo:decide-config-proposal',
      'decide-config-proposal',
      configurationDecisionSchema,
    ],
    ['nesvo:undo-config-change', 'undo-config-change', configurationUndoSchema],
    [
      'nesvo:enroll-config-device',
      'enroll-config-device',
      configurationEnrollSchema,
    ],
    [
      'nesvo:revoke-config-device',
      'revoke-config-device',
      externalInboxDeviceIdSchema,
    ],
    ['nesvo:list-inbox-rules', 'list-inbox-rules', listInboxRulesSchema],
    [
      'nesvo:validate-inbox-rule',
      'validate-inbox-rule',
      validateInboxRuleSchema,
    ],
    ['nesvo:save-inbox-rule', 'save-inbox-rule', saveInboxRuleSchema],
    ['nesvo:delete-inbox-rule', 'delete-inbox-rule', deleteInboxRuleSchema],
    [
      'nesvo:set-inbox-rule-enabled',
      'set-inbox-rule-enabled',
      setInboxRuleEnabledSchema,
    ],
    ['nesvo:propose-inbox-rule', 'propose-inbox-rule', proposeInboxRuleSchema],
    ['nesvo:decide-inbox-item', 'decide-inbox-item', decideInboxItemSchema],
    ['nesvo:save-inbox-settings', 'save-inbox-settings', inboxSettingsSchema],
    [
      'nesvo:enroll-external-inbox-device',
      'enroll-external-inbox-device',
      externalInboxDeviceNameSchema,
    ],
    [
      'nesvo:revoke-external-inbox-device',
      'revoke-external-inbox-device',
      externalInboxDeviceIdSchema,
    ],
  ] as const;
  for (const [channel, method, schema] of inboxRuleCalls)
    handle(channel, (event, input: unknown, hostId: unknown) => {
      authorize(event);
      return computers.execute(method, schema.parse(input), route(hostId));
    });
  handle('nesvo:list-inbox-items', (event, hostId: unknown) => {
    authorize(event);
    return computers.execute('list-inbox-items', undefined, route(hostId));
  });
  handle('nesvo:list-config-devices', (event, hostId: unknown) => {
    authorize(event);
    return computers.execute('list-config-devices', undefined, route(hostId));
  });
  handle('nesvo:list-external-inbox-devices', (event, hostId: unknown) => {
    authorize(event);
    return computers.execute(
      'list-external-inbox-devices',
      undefined,
      route(hostId),
    );
  });
  handle('nesvo:read-inbox-cli-installation', event => {
    authorize(event);
    return inboxCliInstallation();
  });
  handle('nesvo:read-inbox-settings', (event, hostId: unknown) => {
    authorize(event);
    return computers.execute('read-inbox-settings', undefined, route(hostId));
  });
  handle(
    'nesvo:list-running-apps',
    (event, hostId: unknown, query: unknown) => {
      authorize(event);
      return computers.execute(
        'list-running-apps',
        runningAppQuerySchema.optional().parse(query),
        route(hostId),
      );
    },
  );
  handle('nesvo:claude-autonomy', (event, input: unknown, hostId: unknown) => {
    authorize(event);
    return computers.execute(
      'claude-autonomy',
      claudeAutonomyInputSchema.parse(input),
      route(hostId),
    );
  });
  handle('nesvo:read-default-session-folder', (event, hostId: unknown) => {
    authorize(event);
    return computers.execute(
      'read-default-session-folder',
      undefined,
      route(hostId),
    );
  });
  handle(
    'nesvo:set-default-session-folder',
    (event, input: unknown, hostId: unknown) => {
      authorize(event);
      return computers.execute(
        'set-default-session-folder',
        setDefaultSessionFolderSchema.parse(input),
        route(hostId),
      );
    },
  );
  handle('nesvo:list-worktree-recipes', (event, hostId: unknown) => {
    authorize(event);
    return computers.execute('list-worktree-recipes', undefined, route(hostId));
  });
  const worktreeRecipeCommands = {
    'save-worktree-recipe': saveWorktreeRecipeSchema,
    'delete-worktree-recipe': deleteWorktreeRecipeSchema,
    'match-worktree-recipe': matchWorktreeRecipeSchema,
    'start-worktree-recipe-trial': startWorktreeRecipeTrialSchema,
    'read-worktree-recipe-trial': worktreeRecipeTrialRefSchema,
    'stop-worktree-recipe-trial': worktreeRecipeTrialRefSchema,
    'read-session-worktree-recipe': readSessionWorktreeRecipeSchema,
    'decide-session-worktree-recipe': decideSessionWorktreeRecipeSchema,
  } as const;
  for (const method of Object.keys(
    worktreeRecipeCommands,
  ) as (keyof typeof worktreeRecipeCommands)[]) {
    handle(`nesvo:${method}`, (event, input: unknown, hostId: unknown) => {
      authorize(event);
      return computers.execute(
        method,
        worktreeRecipeCommands[method].parse(input),
        route(hostId),
      );
    });
  }
  for (const method of [
    'list-tracked-repositories',
    'suggest-tracked-repositories',
  ] as const)
    handle(`nesvo:${method}`, (event, hostId: unknown) => {
      authorize(event);
      return computers.execute(method, undefined, route(hostId));
    });
  const trackedRepositoryCommands = {
    'add-tracked-repository': addTrackedRepositorySchema,
    'remove-tracked-repository': removeTrackedRepositorySchema,
    'reorder-tracked-repositories': reorderTrackedRepositoriesSchema,
    'list-tracked-pull-requests': listTrackedPullRequestsSchema,
  } as const;
  for (const method of Object.keys(
    trackedRepositoryCommands,
  ) as (keyof typeof trackedRepositoryCommands)[]) {
    handle(`nesvo:${method}`, (event, input: unknown, hostId: unknown) => {
      authorize(event);
      return computers.execute(
        method,
        trackedRepositoryCommands[method].parse(input),
        route(hostId),
      );
    });
  }
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
  handle('nesvo:read-code-review-settings', (event, hostId: unknown) => {
    authorize(event);
    return computers.execute(
      'read-code-review-settings',
      undefined,
      route(hostId),
    );
  });
  const codeReviewCommands = {
    'save-reviewer-profile': saveReviewerProfileSchema,
    'delete-reviewer-profile': deleteReviewerProfileSchema,
    'save-review-convention': saveReviewConventionSchema,
    'delete-review-convention': deleteReviewConventionSchema,
    'start-pull-request-review': startPullRequestReviewSchema,
    'list-pull-request-reviews': listPullRequestReviewsSchema,
    'update-review-finding': updateReviewFindingSchema,
    'discard-pull-request-review': discardPullRequestReviewSchema,
    'publish-pull-request-review': publishPullRequestReviewSchema,
  } as const;
  for (const method of Object.keys(
    codeReviewCommands,
  ) as (keyof typeof codeReviewCommands)[]) {
    handle(`nesvo:${method}`, (event, input: unknown, hostId: unknown) => {
      authorize(event);
      return computers.execute(
        method,
        codeReviewCommands[method].parse(input),
        route(hostId),
      );
    });
  }
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
  handle(
    'nesvo:list-manager-import',
    async (event, input: unknown, hostId: unknown) => {
      authorize(event);
      return computers.execute(
        'list-manager-import',
        listManagerImportSchema.parse(input),
        route(hostId),
      );
    },
  );
  handle(
    'nesvo:adopt-manager-import',
    async (event, input: unknown, hostId: unknown) => {
      authorize(event);
      return computers.execute(
        'adopt-manager-import',
        adoptManagerImportSchema.parse(input),
        route(hostId),
      );
    },
  );
  handle(
    'nesvo:list-conversations',
    async (event, hostId: unknown, input: unknown) => {
      authorize(event);
      return computers.execute(
        'list-conversations',
        input === undefined ? undefined : listConversationsSchema.parse(input),
        route(hostId),
      );
    },
  );
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
    'nesvo:search-transcripts',
    async (event, input: unknown, hostId: unknown) => {
      authorize(event);
      return computers.execute(
        'search-transcripts',
        transcriptSearchInputSchema.parse(input),
        route(hostId),
      );
    },
  );
  handle(
    'nesvo:set-session-terminal',
    async (event, input: unknown, hostId: unknown) => {
      authorize(event);
      return computers.execute(
        'set-session-terminal',
        setSessionTerminalSchema.parse(input),
        route(hostId),
      );
    },
  );
  handle(
    'nesvo:open-session-terminal',
    async (event, input: unknown, hostId: unknown) => {
      authorize(event);
      const { sessionId } = openSessionTerminalSchema.parse(input);
      if (route(hostId) !== 'local')
        throw new Error(
          'Sessions on other computers open in a terminal there. Copy the command instead.',
        );
      const current = await computers.getSession({ sessionId }, 'local', {
        remember: false,
      });
      const resume = terminalResume(
        current.provider,
        current.providerSessionId,
        current.directory,
      );
      if (!resume)
        throw new Error(
          'This session has no provider conversation to resume yet. Send a first message in Nesvo.',
        );
      if (current.profileId)
        throw new Error(
          `This session uses a separate ${current.provider} account. Open a terminal, set ${current.provider === 'Claude Code' ? 'CLAUDE_CONFIG_DIR' : 'CODEX_HOME'} to that account's folder and run: ${resume.executable} ${resume.args.join(' ')}`,
        );
      const session = await computers.execute(
        'set-session-terminal',
        { sessionId, attached: true },
        'local',
      );
      try {
        const terminal = await launchTerminal(resume, terminalLaunchLog);
        return { session, terminal };
      } catch (error) {
        if (!current.externalAttachment)
          await computers
            .execute(
              'set-session-terminal',
              { sessionId, attached: false },
              'local',
            )
            .catch(() => undefined);
        throw error;
      }
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
    'nesvo:read-session-changes',
    async (event, input: unknown, hostId: unknown) => {
      authorize(event);
      return computers.execute(
        'read-session-changes',
        readSessionChangesSchema.parse(input),
        route(hostId),
      );
    },
  );
  handle(
    'nesvo:read-session-change-patch',
    async (event, input: unknown, hostId: unknown) => {
      authorize(event);
      return computers.execute(
        'read-session-change-patch',
        readSessionChangePatchSchema.parse(input),
        route(hostId),
      );
    },
  );
  handle(
    'nesvo:stage-attachment',
    async (event, input: unknown, hostId: unknown) => {
      authorize(event);
      return computers.execute(
        'stage-attachment',
        stageAttachmentSchema.parse(input),
        route(hostId),
      );
    },
  );
  handle(
    'nesvo:open-attachment',
    async (event, input: unknown, hostId: unknown) => {
      authorize(event);
      const { action, ...target } = openAttachmentSchema.parse(input);
      if (route(hostId) !== 'local')
        throw new Error(
          'Files attached on another computer stay on that computer.',
        );
      const location = attachmentLocationSchema.parse(
        await computers.execute('locate-attachment', target, 'local'),
      );
      await openAttachmentFile(hostDirectory, location, action);
    },
  );
  handle(
    'nesvo:read-attachment',
    async (event, input: unknown, hostId: unknown) => {
      authorize(event);
      return computers.execute(
        'read-attachment',
        readAttachmentSchema.parse(input),
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
    'nesvo:trust-repository-mcp',
    async (event, input: unknown, hostId: unknown) => {
      authorize(event);
      return computers.execute(
        'trust-repository-mcp',
        trustRepositoryMcpSchema.parse(input),
        route(hostId),
      );
    },
  );
  handle(
    'nesvo:mcp-connections',
    async (event, input: unknown, hostId: unknown) => {
      authorize(event);
      const id = route(hostId);
      return computers.execute(
        'mcp-connections',
        { ...mcpConnectionRequestSchema.parse(input), browser: id === 'local' },
        id,
      );
    },
  );
  handle('nesvo:open-mcp-terminal', async (event, input: unknown) => {
    authorize(event);
    const { provider, profileId } = mcpProfileTargetSchema.parse(input);
    const profile = profileId
      ? providerProfileListSchema
          .parse(
            await computers.execute(
              'list-provider-profiles',
              undefined,
              'local',
            ),
          )
          .find(entry => entry.id === profileId && entry.provider === provider)
      : undefined;
    if (profileId && !profile)
      throw new Error('This provider profile is no longer available.');
    await launchMcpTerminal(
      provider,
      hostDirectory,
      profile?.configDirectory,
      terminalLaunchLog,
    );
  });
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
    'resume-session': resumeSessionSchema,
    'compact-session': compactSessionSchema,
    'read-merged-worktree-cleanup': readMergedWorktreeCleanupSchema,
    'finish-merged-worktree': finishMergedWorktreeSchema,
  } as const;
  for (const method of [
    'fork-session',
    'restart-session',
    'resume-session',
    'compact-session',
    'read-merged-worktree-cleanup',
    'finish-merged-worktree',
  ] as const) {
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
  const sessionDeletionInputs = {
    'delete-session': deleteSessionSchema,
    'restore-session': restoreSessionSchema,
  } as const;
  for (const method of ['delete-session', 'restore-session'] as const)
    handle(
      `nesvo:${method}`,
      async (event, input: unknown, hostId: unknown) => {
        authorize(event);
        return computers.execute(
          method,
          sessionDeletionInputs[method].parse(input),
          route(hostId),
        );
      },
    );
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
  if (!smokeTest) indicators.start();
  void computers
    .initialize()
    .catch(() => log.error('Computers could not be initialized.'));
  powerMonitor.on('resume', () => computers.resume());
  deliverImportLink = link => {
    if (!smokeTest) showWindow();
    void sharing.deliverLink(link);
  };
  for (const link of pendingImportLinks.splice(0)) deliverImportLink(link);
  app.on('second-instance', (_event, argv) => {
    if (erasing) return;
    if (!window) createWindow();
    if (window && !smokeTest) {
      if (window.isMinimized()) window.restore();
      window.show();
      window.focus();
    }
    const link = findImportLink(argv);
    if (link) deliverImportLink(link);
  });
  app.on('activate', () => {
    if (erasing) return;
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
    else if (window && !window.isVisible()) showWindow();
  });
  app.on('window-all-closed', () => {
    if (!erasing && (process.platform !== 'darwin' || smokeTest)) app.quit();
  });
  let closing = false;
  let closed = false;
  const closeWorkspace = async () => {
    quitting = true;
    await mobile.close().catch(() => undefined);
    await computers.close();
    indicators.destroy();
  };
  app.on('before-quit', event => {
    if (closed) return;
    event.preventDefault();
    if (closing || erasing) return;
    closing = true;
    void closeWorkspace().finally(() => {
      closed = true;
      app.quit();
    });
  });
});
