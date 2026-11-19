import {
  retentionDaysSchema,
  transcriptRetentionSchema,
  workLaptopPolicySchema,
} from '@nesvo/contracts';
import { contextBridge, ipcRenderer as electronIpcRenderer } from 'electron';
import {
  configurationDecisionSchema,
  configurationDevicesSchema,
  configurationEnrollmentSchema,
  configurationEnrollSchema,
  configurationHistoryInputSchema,
  configurationInspectDraftSchema,
  configurationInboxLookupResultSchema,
  configurationInboxLookupSchema,
  configurationInboxSendResultSchema,
  configurationInboxSendSchema,
  configurationResultSchema,
  configurationProfileInputSchema,
  configurationProfileSchema,
  configurationUndoSchema,
} from '@nesvo/contracts';
import {
  aboutInfoSchema,
  databaseBackupSchema,
  saveTextFileSchema,
  savedTextFileSchema,
  claudeStatusSchema,
  codexStatusSchema,
  colorSchemeSchema,
  appliedColorSchemeSchema,
  chooseDirectoryResultSchema,
  onboardingOpenSchema,
  reviewWorkingRulesSchema,
  workingRulesReviewSchema,
  attentionSessionSchema,
  desktopAttentionSchema,
  keepRunningInBackgroundSchema,
  respondApprovalSchema,
  setupProfileInputSchema,
  setupProfileResultSchema,
  setupDetectionInputSchema,
  setupDetectionResultSchema,
  desktopConfigurationOwnerInputSchema,
  desktopConfigurationOwnerResultSchema,
  createSessionSchema,
  readSessionWorktreeSchema,
  sessionWorktreeStatusSchema,
  finishSessionWorktreeSchema,
  runSessionWorktreeSetupSchema,
  removeOrphanedSessionWorktreeSchema,
  sessionWorktreeSetupSchema,
  sessionWorktreeSetupResultSchema,
  orphanedSessionWorktreesSchema,
  orphanedSessionWorktreeRemovalSchema,
  decideDelegationSchema,
  decideWorkerPlanSchema,
  decideSessionParentSchema,
  continueCoordinatorSchema,
  continueWorkerSchema,
  workerWorktreeInputSchema,
  workerWorktreeResultSchema,
  decideSessionPlanSchema,
  decideInboxItemSchema,
  externalInboxDeviceIdSchema,
  externalInboxDeviceNameSchema,
  externalInboxDevicesSchema,
  externalInboxEnrollmentSchema,
  inboxCliInstallationSchema,
  deleteInboxRuleSchema,
  inboxItemSchema,
  inboxRuleCatalogSchema,
  inboxRuleProposalSchema,
  inboxRuleValidationSchema,
  inboxSettingsSchema,
  listInboxRulesSchema,
  proposeInboxRuleSchema,
  saveInboxRuleSchema,
  setInboxRuleEnabledSchema,
  validateInboxRuleSchema,
  answerSessionQuestionSchema,
  coordinatorPolicySchema,
  coordinatorWakeTargetSchema,
  coordinatorWakeStateSchema,
  setCoordinatorWakeSchema,
  continueCoordinatorDeliverySchema,
  coordinatorDeliveryReceiptSchema,
  ownerSteerInputSchema,
  sessionSteerResultSchema,
  decideSteeringInputSchema,
  ownerChildWorkInputSchema,
  childWorkPageSchema,
  decideReviewSchema,
  hostHealthSchema,
  assignSessionWorkflowSchema,
  forkSessionSchema,
  restartSessionSchema,
  resumeSessionSchema,
  readMergedWorktreeCleanupSchema,
  finishMergedWorktreeSchema,
  mergedWorktreeCleanupSchema,
  mergedWorktreeFinishSchema,
  compactSessionSchema,
  createSessionGroupSchema,
  deleteSessionGroupSchema,
  moveSessionGroupSchema,
  moveSessionSchema,
  renameSessionSchema,
  sessionGroupListSchema,
  setSessionArchivedSchema,
  deleteSessionSchema,
  desktopSessionDeletionSchema,
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
  sessionChangesSchema,
  sessionChangePatchSchema,
  attachmentContentSchema,
  attachmentUploadSchema,
  readAttachmentSchema,
  openAttachmentSchema,
  stageAttachmentSchema,
  readGitBranchSchema,
  historySearchInputSchema,
  openSessionTerminalSchema,
  openedSessionTerminalSchema,
  setSessionTerminalSchema,
  transcriptSearchInputSchema,
  transcriptSearchPageSchema,
  conversationImportCatalogSchema,
  adoptConversationSchema,
  adoptManagerImportSchema,
  listManagerImportSchema,
  managerImportCatalogSchema,
  managerImportResultSchema,
  providerProfileListSchema,
  codeReviewSettingsSchema,
  saveReviewerProfileSchema,
  deleteReviewerProfileSchema,
  saveReviewConventionSchema,
  deleteReviewConventionSchema,
  lessonOverviewSchema,
  gateRuleOverviewSchema,
  gateRulesInputSchema,
  lessonSettingsSchema,
  proposeLessonsSchema,
  decideLessonSchema,
  startPullRequestReviewSchema,
  listPullRequestReviewsSchema,
  updateReviewFindingSchema,
  discardPullRequestReviewSchema,
  publishPullRequestReviewSchema,
  desktopReviewDraftSchema,
  desktopReviewPublishResultSchema,
  createProviderProfileSchema,
  renameProviderProfileSchema,
  removeProviderProfileSchema,
  providerProfileSelectionSchema,
  listConversationsSchema,
  historySearchPageSchema,
  gitBranchSchema,
  listPullRequestsSchema,
  addTrackedRepositorySchema,
  removeTrackedRepositorySchema,
  reorderTrackedRepositoriesSchema,
  listTrackedPullRequestsSchema,
  trackedRepositoryListSchema,
  runningAppListSchema,
  defaultSessionFolderSchema,
  setDefaultSessionFolderSchema,
  claudeAutonomyInputSchema,
  claudeAutonomySchema,
  saveWorktreeRecipeSchema,
  deleteWorktreeRecipeSchema,
  matchWorktreeRecipeSchema,
  startWorktreeRecipeTrialSchema,
  worktreeRecipeTrialRefSchema,
  readSessionWorktreeRecipeSchema,
  decideSessionWorktreeRecipeSchema,
  worktreeRecipeListSchema,
  worktreeRecipeMatchSchema,
  worktreeRecipeRunSchema,
  trackedRepositorySuggestionListSchema,
  trackedPullRequestListsSchema,
  readPullRequestSchema,
  actOnPullRequestSchema,
  linkSessionPullRequestSchema,
  findSessionPullRequestSchema,
  pullRequestListSchema,
  pullRequestSchema,
  pullRequestFilesSchema,
  pullRequestThreadsSchema,
  pullRequestActionResultSchema,
  pullRequestReferenceSchema,
  workspaceDirectorySchema,
  workspaceSearchSchema,
  workspaceFileSchema,
  discoverSkillsSchema,
  claudeCommandListSchema,
  listClaudeCommandsSchema,
  listMcpServersSchema,
  mcpConnectionRequestSchema,
  mcpProfileTargetSchema,
  mcpConnectionListSchema,
  trustRepositoryMcpSchema,
  repositoryTrustSettingsInputSchema,
  repositoryTrustSettingsSchema,
  worktreeProviderInputSchema,
  worktreeProviderReplySchema,
  providerUsageGateInputSchema,
  providerUsageGateSettingsSchema,
  readonlyIntegrationInputSchema,
  readonlyIntegrationReplySchema,
  externalSessionSettingsInputSchema,
  externalSessionSettingsSchema,
  sessionMessageWatcherInputSchema,
  sessionMessageWatcherReplySchema,
  mcpServerListSchema,
  setSessionMcpSchema,
  skillCatalogSchema,
  computerSchema,
  desktopSessionSchema,
  desktopReviewSchema,
  getSessionSchema,
  readSessionMessagesSchema,
  sessionMessagePageSchema,
  hostIdSchema,
  sshComputerInputSchema,
  workspaceEventSchema,
  providerUsageInputSchema,
  providerUsageSchema,
  readCostsSchema,
  costReportSchema,
  costBudgetListSchema,
  createCostBudgetSchema,
  costBudgetSchema,
  deleteCostBudgetSchema,
  mobileDeviceSchema,
  mobileGatewayStatusSchema,
  mobilePairingSchema,
  desktopScheduledJobSchema,
  desktopScheduledJobRunSchema,
  desktopScheduledJobRunPageSchema,
  decideScheduledJobStartSchema,
  deleteScheduledJobSchema,
  listScheduledJobRunsSchema,
  runScheduledJobNowSchema,
  saveScheduledJobSchema,
  setScheduledJobActiveSchema,
  decideWorkflowGateSchema,
  definitionCatalogSchema,
  definitionWriteResultSchema,
  deleteWorkflowDefinitionSchema,
  desktopWorkflowRunDetailSchema,
  desktopWorkflowRunPageSchema,
  desktopWorkflowRunSchema,
  getWorkflowRunSchema,
  listWorkflowDefinitionsSchema,
  listWorkflowRunsSchema,
  workflowEvidenceSchema,
  workflowMetricsInputSchema,
  workflowMetricsSchema,
  workflowAssistantSendSchema,
  assistantChangeHistorySchema,
  assistantUndoResultSchema,
  assistantUndoSchema,
  listAssistantChangesSchema,
  workflowAssistantTurnSchema,
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
  type DesktopApi,
  type RendererErrorReport,
  prepareWorkflowShareSchema,
  saveWorkflowImportSchema,
  sharedWorkflowLinkSchema,
  workflowImportOfferSchema,
  workflowImportResultSchema,
  workflowShareIdSchema,
  workflowSharePreparedSchema,
  workflowShareSettingsSchema,
} from '@nesvo/contracts';

const launchColorScheme = appliedColorSchemeSchema.safeParse(
  process.argv
    .find(argument => argument.startsWith('--nesvo-color-scheme='))
    ?.split('=')[1],
);
const onboardingOnLaunch = !process.argv.includes('--nesvo-onboarding=skip');
const ipcRenderer = {
  invoke,
  send: electronIpcRenderer.send.bind(electronIpcRenderer),
  on: electronIpcRenderer.on.bind(electronIpcRenderer),
  removeListener: electronIpcRenderer.removeListener.bind(electronIpcRenderer),
};

const reportError = (report: RendererErrorReport) =>
  ipcRenderer.send('nesvo:report-error', report);
let droppedEvents = 0;
const reportDroppedEvent = (payload: unknown, issues: string) => {
  droppedEvents += 1;
  const type =
    payload && typeof payload === 'object' && 'type' in payload
      ? String(payload.type).slice(0, 80)
      : 'unknown';
  reportError({
    kind: 'dropped-event',
    message: `Dropped an invalid ${type} event (${droppedEvents} so far).`,
    stack: issues.slice(0, 16_000),
  });
};
const route = (hostId: string | undefined) =>
  hostIdSchema.parse(hostId ?? 'local');
const scheduledJobs: DesktopApi['scheduledJobs'] = {
  list: async hostId =>
    desktopScheduledJobSchema
      .array()
      .parse(
        await ipcRenderer.invoke(
          'nesvo:list-scheduled-jobs',
          hostIdSchema.parse(hostId),
        ),
      ),
  save: async (hostId, input, expectedRevision) =>
    desktopScheduledJobSchema.parse(
      await ipcRenderer.invoke(
        'nesvo:save-scheduled-job',
        saveScheduledJobSchema.parse({ ...input, expectedRevision }),
        hostIdSchema.parse(hostId),
      ),
    ),
  setActive: async (hostId, id, active, expectedRevision) =>
    desktopScheduledJobSchema.parse(
      await ipcRenderer.invoke(
        'nesvo:set-scheduled-job-active',
        setScheduledJobActiveSchema.parse({ id, active, expectedRevision }),
        hostIdSchema.parse(hostId),
      ),
    ),
  delete: async (hostId, id, expectedRevision) => {
    await ipcRenderer.invoke(
      'nesvo:delete-scheduled-job',
      deleteScheduledJobSchema.parse({ id, expectedRevision }),
      hostIdSchema.parse(hostId),
    );
  },
  runNow: async (hostId, id, requestId) =>
    desktopScheduledJobRunSchema.parse(
      await ipcRenderer.invoke(
        'nesvo:run-scheduled-job-now',
        runScheduledJobNowSchema.parse({ id, requestId }),
        hostIdSchema.parse(hostId),
      ),
    ),
  decideStart: async (hostId, input) =>
    desktopScheduledJobSchema.parse(
      await ipcRenderer.invoke(
        'nesvo:decide-scheduled-job-start',
        decideScheduledJobStartSchema.parse(input),
        hostIdSchema.parse(hostId),
      ),
    ),
  listRuns: async (hostId, id, cursor) =>
    desktopScheduledJobRunPageSchema.parse(
      await ipcRenderer.invoke(
        'nesvo:list-scheduled-job-runs',
        listScheduledJobRunsSchema.parse({ scheduledJobId: id, cursor }),
        hostIdSchema.parse(hostId),
      ),
    ),
};
const sharedLinksSchema = sharedWorkflowLinkSchema.array();
const sharing: DesktopApi['sharing'] = {
  settings: async () =>
    workflowShareSettingsSchema.parse(
      await ipcRenderer.invoke('nesvo:share-settings'),
    ),
  setOrigin: async origin =>
    workflowShareSettingsSchema.parse(
      await ipcRenderer.invoke(
        'nesvo:set-share-origin',
        workflowShareSettingsSchema.shape.origin.nullable().parse(origin),
      ),
    ),
  prepare: async (hostId, input) =>
    workflowSharePreparedSchema.parse(
      await ipcRenderer.invoke(
        'nesvo:prepare-workflow-share',
        hostIdSchema.parse(hostId),
        prepareWorkflowShareSchema.parse(input),
      ),
    ),
  upload: async draftId =>
    sharedWorkflowLinkSchema.parse(
      await ipcRenderer.invoke(
        'nesvo:upload-workflow-share',
        workflowSharePreparedSchema.shape.draftId.parse(draftId),
      ),
    ),
  links: async () =>
    sharedLinksSchema.parse(
      await ipcRenderer.invoke('nesvo:shared-workflow-links'),
    ),
  revoke: async id =>
    sharedLinksSchema.parse(
      await ipcRenderer.invoke(
        'nesvo:revoke-workflow-share',
        workflowShareIdSchema.parse(id),
      ),
    ),
  forget: async id =>
    sharedLinksSchema.parse(
      await ipcRenderer.invoke(
        'nesvo:forget-workflow-share',
        workflowShareIdSchema.parse(id),
      ),
    ),
  takeImports: async () =>
    workflowImportOfferSchema
      .array()
      .parse(await ipcRenderer.invoke('nesvo:take-workflow-imports')),
  onImportAvailable: listener => {
    const receive = () => listener();
    ipcRenderer.on('nesvo:workflow-import-available', receive);
    return () =>
      ipcRenderer.removeListener('nesvo:workflow-import-available', receive);
  },
  importWorkflow: async input =>
    workflowImportResultSchema.parse(
      await ipcRenderer.invoke(
        'nesvo:import-workflow',
        saveWorkflowImportSchema.parse(input),
      ),
    ),
  dismissImport: async importId => {
    await ipcRenderer.invoke(
      'nesvo:dismiss-workflow-import',
      saveWorkflowImportSchema.shape.importId.parse(importId),
    );
  },
  pickFolder: async () => {
    const folder: unknown = await ipcRenderer.invoke(
      'nesvo:pick-import-folder',
    );
    return typeof folder === 'string' ? folder : null;
  },
};
const workflows: DesktopApi['workflows'] = {
  listDefinitions: async (hostId, input) =>
    definitionCatalogSchema.parse(
      await ipcRenderer.invoke(
        'nesvo:list-workflow-definitions',
        listWorkflowDefinitionsSchema.parse(input),
        hostIdSchema.parse(hostId),
      ),
    ),
  validateDefinitions: async (hostId, input) =>
    definitionCatalogSchema.parse(
      await ipcRenderer.invoke(
        'nesvo:validate-workflow-definitions',
        validateWorkflowDefinitionsSchema.parse(input),
        hostIdSchema.parse(hostId),
      ),
    ),
  startTask: async (hostId, input) =>
    desktopWorkflowRunSchema.parse(
      await ipcRenderer.invoke(
        'nesvo:start-workflow-task',
        startWorkflowTaskSchema.parse(input),
        hostIdSchema.parse(hostId),
      ),
    ),
  runSteps: async (hostId, input) =>
    desktopWorkflowRunSchema.parse(
      await ipcRenderer.invoke(
        'nesvo:run-workflow-steps',
        runWorkflowStepsSchema.parse(input),
        hostIdSchema.parse(hostId),
      ),
    ),
  listRuns: async (hostId, input) =>
    desktopWorkflowRunPageSchema.parse(
      await ipcRenderer.invoke(
        'nesvo:list-workflow-runs',
        listWorkflowRunsSchema.parse(input),
        hostIdSchema.parse(hostId),
      ),
    ),
  getRun: async (hostId, runId) =>
    desktopWorkflowRunDetailSchema.parse(
      await ipcRenderer.invoke(
        'nesvo:get-workflow-run',
        getWorkflowRunSchema.parse({ runId }),
        hostIdSchema.parse(hostId),
      ),
    ),
  decideGate: async (hostId, input) =>
    desktopWorkflowRunSchema.parse(
      await ipcRenderer.invoke(
        'nesvo:decide-workflow-gate',
        decideWorkflowGateSchema.parse(input),
        hostIdSchema.parse(hostId),
      ),
    ),
  skipStep: async (hostId, input) =>
    desktopWorkflowRunSchema.parse(
      await ipcRenderer.invoke(
        'nesvo:skip-workflow-step',
        skipWorkflowStepSchema.parse(input),
        hostIdSchema.parse(hostId),
      ),
    ),
  resolveStep: async (hostId, input) =>
    desktopWorkflowRunSchema.parse(
      await ipcRenderer.invoke(
        'nesvo:resolve-workflow-step',
        resolveWorkflowStepSchema.parse(input),
        hostIdSchema.parse(hostId),
      ),
    ),
  resumeRun: async (hostId, runId) =>
    desktopWorkflowRunSchema.parse(
      await ipcRenderer.invoke(
        'nesvo:resume-workflow-run',
        resumeWorkflowRunSchema.parse({ runId }),
        hostIdSchema.parse(hostId),
      ),
    ),
  stopRun: async (hostId, runId) =>
    desktopWorkflowRunSchema.parse(
      await ipcRenderer.invoke(
        'nesvo:stop-workflow-run',
        stopWorkflowRunSchema.parse({ runId }),
        hostIdSchema.parse(hostId),
      ),
    ),
  saveDefinition: async (hostId, input) =>
    definitionWriteResultSchema.parse(
      await ipcRenderer.invoke(
        'nesvo:save-workflow-definition',
        saveWorkflowDefinitionSchema.parse(input),
        hostIdSchema.parse(hostId),
      ),
    ),
  deleteDefinition: async (hostId, input) =>
    definitionWriteResultSchema.parse(
      await ipcRenderer.invoke(
        'nesvo:delete-workflow-definition',
        deleteWorkflowDefinitionSchema.parse(input),
        hostIdSchema.parse(hostId),
      ),
    ),
  removeWorktree: async (hostId, runId) =>
    desktopWorkflowRunSchema.parse(
      await ipcRenderer.invoke(
        'nesvo:remove-workflow-worktree',
        removeWorkflowWorktreeSchema.parse({ runId }),
        hostIdSchema.parse(hostId),
      ),
    ),
  readEvidence: async (hostId, input) =>
    workflowEvidenceSchema.parse(
      await ipcRenderer.invoke(
        'nesvo:read-workflow-evidence',
        readWorkflowEvidenceSchema.parse(input),
        hostIdSchema.parse(hostId),
      ),
    ),
  metrics: async (hostId, input) =>
    workflowMetricsSchema.parse(
      await ipcRenderer.invoke(
        'nesvo:workflow-metrics',
        workflowMetricsInputSchema.parse(input),
        hostIdSchema.parse(hostId),
      ),
    ),
  assistantSend: async (hostId, input) =>
    workflowAssistantTurnSchema.parse(
      await ipcRenderer.invoke(
        'nesvo:workflow-assistant-send',
        workflowAssistantSendSchema.parse(input),
        hostIdSchema.parse(hostId),
      ),
    ),
  assistantUndo: async (hostId, input) =>
    assistantUndoResultSchema.parse(
      await ipcRenderer.invoke(
        'nesvo:workflow-assistant-undo',
        assistantUndoSchema.parse(input),
        hostIdSchema.parse(hostId),
      ),
    ),
  assistantChanges: async (hostId, conversationId) =>
    assistantChangeHistorySchema.parse(
      await ipcRenderer.invoke(
        'nesvo:workflow-assistant-changes',
        listAssistantChangesSchema.parse({ conversationId }),
        hostIdSchema.parse(hostId),
      ),
    ),
};
const api: DesktopApi = {
  setupDetection: async (input, hostId) =>
    setupDetectionResultSchema.parse(
      await ipcRenderer.invoke(
        'nesvo:setup-detection',
        setupDetectionInputSchema.parse(input),
        hostIdSchema.parse(hostId),
      ),
    ),
  setupProfile: async (input, hostId) =>
    setupProfileResultSchema.parse(
      await ipcRenderer.invoke(
        'nesvo:setup-profile',
        setupProfileInputSchema.parse(input),
        hostIdSchema.parse(hostId),
      ),
    ),
  configuration: {
    completeReview: async (input, hostId) =>
      desktopConfigurationOwnerResultSchema.parse(
        await ipcRenderer.invoke(
          'nesvo:complete-configuration-review',
          desktopConfigurationOwnerInputSchema.parse(input),
          hostIdSchema.parse(hostId),
        ),
      ),
    draft: async (input, hostId) =>
      configurationResultSchema.parse(
        await ipcRenderer.invoke(
          'nesvo:inspect-config-draft',
          configurationInspectDraftSchema.parse(input),
          hostIdSchema.parse(hostId),
        ),
      ),
    profile: async input =>
      configurationProfileSchema.parse(
        await ipcRenderer.invoke(
          'nesvo:desktop-configuration-profile',
          configurationProfileInputSchema.parse(input),
        ),
      ),
    lookup: async (input, hostId) =>
      configurationInboxLookupResultSchema.parse(
        await ipcRenderer.invoke(
          'nesvo:lookup-inbox-assistant',
          configurationInboxLookupSchema.parse(input),
          hostIdSchema.parse(hostId),
        ),
      ),
    send: async (input, hostId) =>
      configurationInboxSendResultSchema.parse(
        await ipcRenderer.invoke(
          'nesvo:send-inbox-assistant',
          configurationInboxSendSchema.parse(input),
          hostIdSchema.parse(hostId),
        ),
      ),
    history: async (input, hostId) =>
      configurationResultSchema.parse(
        await ipcRenderer.invoke(
          'nesvo:list-config-changes',
          configurationHistoryInputSchema.parse(input),
          hostIdSchema.parse(hostId),
        ),
      ),
    decide: async (input, hostId) =>
      configurationResultSchema.parse(
        await ipcRenderer.invoke(
          'nesvo:decide-config-proposal',
          configurationDecisionSchema.parse(input),
          hostIdSchema.parse(hostId),
        ),
      ),
    undo: async (input, hostId) =>
      configurationResultSchema.parse(
        await ipcRenderer.invoke(
          'nesvo:undo-config-change',
          configurationUndoSchema.parse(input),
          hostIdSchema.parse(hostId),
        ),
      ),
    devices: async hostId =>
      configurationDevicesSchema.parse(
        await ipcRenderer.invoke(
          'nesvo:list-config-devices',
          hostIdSchema.parse(hostId),
        ),
      ),
    enroll: async (input, hostId) => {
      const value = await ipcRenderer.invoke(
        'nesvo:enroll-config-device',
        configurationEnrollSchema.parse(input),
        hostIdSchema.parse(hostId),
      );
      const parsed = configurationEnrollmentSchema.safeParse(value);
      return parsed.success
        ? parsed.data
        : configurationResultSchema.parse(value);
    },
    revoke: async (id, hostId) =>
      configurationDevicesSchema.parse(
        await ipcRenderer.invoke(
          'nesvo:revoke-config-device',
          externalInboxDeviceIdSchema.parse({ deviceId: id }),
          hostIdSchema.parse(hostId),
        ),
      ),
  },
  scheduledJobs,
  workflows,
  sharing,
  colorScheme: async () =>
    colorSchemeSchema.parse(await ipcRenderer.invoke('nesvo:color-scheme')),
  showsOnboardingOnLaunch: () => onboardingOnLaunch,
  setOnboardingOpen: async open => {
    await ipcRenderer.invoke(
      'nesvo:set-onboarding-open',
      onboardingOpenSchema.parse(open),
    );
  },
  chooseDirectory: async () =>
    chooseDirectoryResultSchema.parse(
      await ipcRenderer.invoke('nesvo:choose-directory'),
    ),
  reviewWorkingRules: async input =>
    workingRulesReviewSchema.parse(
      await ipcRenderer.invoke(
        'nesvo:review-working-rules',
        reviewWorkingRulesSchema.parse(input),
      ),
    ),
  setColorScheme: async scheme =>
    colorSchemeSchema.parse(
      await ipcRenderer.invoke(
        'nesvo:set-color-scheme',
        colorSchemeSchema.parse(scheme),
      ),
    ),
  onAppliedColorScheme: listener => {
    const deliver = (payload: unknown) => {
      const parsed = appliedColorSchemeSchema.safeParse(payload);
      if (parsed.success) listener(parsed.data);
    };
    const receive = (_event: Electron.IpcRendererEvent, payload: unknown) =>
      deliver(payload);
    if (launchColorScheme.success) listener(launchColorScheme.data);
    ipcRenderer.on('nesvo:applied-color-scheme', receive);
    void ipcRenderer.invoke('nesvo:applied-color-scheme').then(deliver);
    return () =>
      ipcRenderer.removeListener('nesvo:applied-color-scheme', receive);
  },
  openExternal: async url => {
    await ipcRenderer.invoke('nesvo:open-external', url);
  },
  openLogs: async () => {
    await ipcRenderer.invoke('nesvo:open-logs');
  },
  about: async () =>
    aboutInfoSchema.parse(await ipcRenderer.invoke('nesvo:about')),
  showDataDirectory: async () => {
    await ipcRenderer.invoke('nesvo:show-data-directory');
  },
  showBackup: async path => {
    await ipcRenderer.invoke('nesvo:show-backup', path);
  },
  openLicenses: async () => {
    await ipcRenderer.invoke('nesvo:open-licenses');
  },
  saveTextFile: async input =>
    savedTextFileSchema.parse(
      await ipcRenderer.invoke(
        'nesvo:save-text-file',
        saveTextFileSchema.parse(input),
      ),
    ),
  transcriptRetention: async () =>
    transcriptRetentionSchema.parse(
      await ipcRenderer.invoke('nesvo:get-transcript-retention'),
    ),
  setTranscriptRetention: async days =>
    transcriptRetentionSchema.parse(
      await ipcRenderer.invoke(
        'nesvo:set-transcript-retention',
        retentionDaysSchema.parse(days),
      ),
    ),
  purgeTranscripts: async () =>
    transcriptRetentionSchema.parse(
      await ipcRenderer.invoke('nesvo:purge-transcripts'),
    ),
  deleteLocalData: async confirmation => {
    await ipcRenderer.invoke('nesvo:delete-local-data', confirmation);
  },
  workLaptopPolicy: async () =>
    workLaptopPolicySchema.parse(
      await ipcRenderer.invoke('nesvo:work-laptop-policy'),
    ),
  setWorkLaptopPolicy: async enabled =>
    workLaptopPolicySchema.parse(
      await ipcRenderer.invoke('nesvo:set-work-laptop-policy', enabled),
    ),
  backupDatabase: async hostId =>
    databaseBackupSchema.parse(
      await ipcRenderer.invoke('nesvo:backup-database', route(hostId)),
    ),
  focusWindow: async () => {
    await ipcRenderer.invoke('nesvo:focus-window');
  },
  requestAttention: async () => {
    await ipcRenderer.invoke('nesvo:request-attention');
  },
  setAttention: async attention => {
    await ipcRenderer.invoke(
      'nesvo:set-attention',
      desktopAttentionSchema.parse(attention),
    );
  },
  onOpenSession: listener => {
    const receive = (_event: Electron.IpcRendererEvent, payload: unknown) => {
      const parsed = attentionSessionSchema.safeParse(payload);
      if (parsed.success) listener(parsed.data);
    };
    ipcRenderer.on('nesvo:open-session', receive);
    return () => ipcRenderer.removeListener('nesvo:open-session', receive);
  },
  keepRunningInBackground: async () =>
    keepRunningInBackgroundSchema.parse(
      await ipcRenderer.invoke('nesvo:keep-running-in-background'),
    ),
  setKeepRunningInBackground: async enabled =>
    keepRunningInBackgroundSchema.parse(
      await ipcRenderer.invoke(
        'nesvo:set-keep-running-in-background',
        keepRunningInBackgroundSchema.parse(enabled),
      ),
    ),
  reportError,
  mobileStatus: async () =>
    mobileGatewayStatusSchema.parse(
      await ipcRenderer.invoke('nesvo:mobile-status'),
    ),
  enableMobile: async () =>
    mobileGatewayStatusSchema.parse(
      await ipcRenderer.invoke('nesvo:enable-mobile'),
    ),
  disableMobile: async () =>
    mobileGatewayStatusSchema.parse(
      await ipcRenderer.invoke('nesvo:disable-mobile'),
    ),
  pairMobile: async () =>
    mobilePairingSchema.parse(await ipcRenderer.invoke('nesvo:pair-mobile')),
  revokeMobile: async deviceId =>
    mobileGatewayStatusSchema.parse(
      await ipcRenderer.invoke(
        'nesvo:revoke-mobile',
        mobileDeviceSchema.shape.id.parse(deviceId),
      ),
    ),
  readCodeReviewSettings: async hostId =>
    codeReviewSettingsSchema.parse(
      await ipcRenderer.invoke(
        'nesvo:read-code-review-settings',
        route(hostId),
      ),
    ),
  saveReviewerProfile: async (input, hostId) =>
    codeReviewSettingsSchema.parse(
      await ipcRenderer.invoke(
        'nesvo:save-reviewer-profile',
        saveReviewerProfileSchema.parse(input),
        route(hostId),
      ),
    ),
  deleteReviewerProfile: async (input, hostId) =>
    codeReviewSettingsSchema.parse(
      await ipcRenderer.invoke(
        'nesvo:delete-reviewer-profile',
        deleteReviewerProfileSchema.parse(input),
        route(hostId),
      ),
    ),
  saveReviewConvention: async (input, hostId) =>
    codeReviewSettingsSchema.parse(
      await ipcRenderer.invoke(
        'nesvo:save-review-convention',
        saveReviewConventionSchema.parse(input),
        route(hostId),
      ),
    ),
  deleteReviewConvention: async (input, hostId) =>
    codeReviewSettingsSchema.parse(
      await ipcRenderer.invoke(
        'nesvo:delete-review-convention',
        deleteReviewConventionSchema.parse(input),
        route(hostId),
      ),
    ),
  startPullRequestReview: async (input, hostId) =>
    desktopReviewDraftSchema.parse(
      await ipcRenderer.invoke(
        'nesvo:start-pull-request-review',
        startPullRequestReviewSchema.parse(input),
        route(hostId),
      ),
    ),
  listPullRequestReviews: async (input, hostId) =>
    desktopReviewDraftSchema
      .array()
      .parse(
        await ipcRenderer.invoke(
          'nesvo:list-pull-request-reviews',
          listPullRequestReviewsSchema.parse(input),
          route(hostId),
        ),
      ),
  updateReviewFinding: async (input, hostId) =>
    desktopReviewDraftSchema.parse(
      await ipcRenderer.invoke(
        'nesvo:update-review-finding',
        updateReviewFindingSchema.parse(input),
        route(hostId),
      ),
    ),
  discardPullRequestReview: async (input, hostId) =>
    desktopReviewDraftSchema.parse(
      await ipcRenderer.invoke(
        'nesvo:discard-pull-request-review',
        discardPullRequestReviewSchema.parse(input),
        route(hostId),
      ),
    ),
  publishPullRequestReview: async (input, hostId) =>
    desktopReviewPublishResultSchema.parse(
      await ipcRenderer.invoke(
        'nesvo:publish-pull-request-review',
        publishPullRequestReviewSchema.parse(input),
        route(hostId),
      ),
    ),
  listProviderProfiles: async hostId =>
    providerProfileListSchema.parse(
      await ipcRenderer.invoke('nesvo:list-provider-profiles', route(hostId)),
    ),
  createProviderProfile: async (input, hostId) =>
    providerProfileListSchema.parse(
      await ipcRenderer.invoke(
        'nesvo:create-provider-profile',
        createProviderProfileSchema.parse(input),
        route(hostId),
      ),
    ),
  renameProviderProfile: async (input, hostId) =>
    providerProfileListSchema.parse(
      await ipcRenderer.invoke(
        'nesvo:rename-provider-profile',
        renameProviderProfileSchema.parse(input),
        route(hostId),
      ),
    ),
  removeProviderProfile: async (input, hostId) =>
    providerProfileListSchema.parse(
      await ipcRenderer.invoke(
        'nesvo:remove-provider-profile',
        removeProviderProfileSchema.parse(input),
        route(hostId),
      ),
    ),
  providerUsage: async (input, hostId) =>
    providerUsageSchema.parse(
      await ipcRenderer.invoke(
        'nesvo:provider-usage',
        providerUsageInputSchema.parse(input),
        route(hostId),
      ),
    ),
  readCosts: async (input, hostId) =>
    costReportSchema.parse(
      await ipcRenderer.invoke(
        'nesvo:read-costs',
        readCostsSchema.parse(input),
        route(hostId),
      ),
    ),
  listCostBudgets: async hostId =>
    costBudgetListSchema.parse(
      await ipcRenderer.invoke('nesvo:list-cost-budgets', route(hostId)),
    ),
  createCostBudget: async (input, hostId) =>
    costBudgetSchema.parse(
      await ipcRenderer.invoke(
        'nesvo:create-cost-budget',
        createCostBudgetSchema.parse(input),
        route(hostId),
      ),
    ),
  updateCostBudget: async (input, hostId) =>
    costBudgetSchema.parse(
      await ipcRenderer.invoke(
        'nesvo:update-cost-budget',
        costBudgetSchema.parse(input),
        route(hostId),
      ),
    ),
  deleteCostBudget: async (input, hostId) =>
    deleteCostBudgetSchema.parse(
      await ipcRenderer.invoke(
        'nesvo:delete-cost-budget',
        deleteCostBudgetSchema.parse(input),
        route(hostId),
      ),
    ),
  listComputers: async () =>
    computerSchema
      .array()
      .parse(await ipcRenderer.invoke('nesvo:list-computers')),
  addComputer: async input =>
    computerSchema.parse(
      await ipcRenderer.invoke(
        'nesvo:add-computer',
        sshComputerInputSchema.parse(input),
      ),
    ),
  connectComputer: async hostId =>
    computerSchema.parse(
      await ipcRenderer.invoke(
        'nesvo:connect-computer',
        hostIdSchema.parse(hostId),
      ),
    ),
  disconnectComputer: async hostId =>
    computerSchema.parse(
      await ipcRenderer.invoke(
        'nesvo:disconnect-computer',
        hostIdSchema.parse(hostId),
      ),
    ),
  removeComputer: async hostId => {
    await ipcRenderer.invoke(
      'nesvo:remove-computer',
      hostIdSchema.parse(hostId),
    );
  },
  health: async hostId =>
    hostHealthSchema.parse(
      await ipcRenderer.invoke('nesvo:health', route(hostId)),
    ),
  claudeStatus: async (hostId, input) =>
    claudeStatusSchema.parse(
      await ipcRenderer.invoke(
        'nesvo:claude-status',
        route(hostId),
        providerProfileSelectionSchema.optional().parse(input),
      ),
    ),
  codexStatus: async (hostId, input) =>
    codexStatusSchema.parse(
      await ipcRenderer.invoke(
        'nesvo:codex-status',
        route(hostId),
        providerProfileSelectionSchema.optional().parse(input),
      ),
    ),
  listSessions: async hostId =>
    desktopSessionSchema
      .array()
      .parse(
        await ipcRenderer.invoke(
          'nesvo:list-sessions',
          hostIdSchema.optional().parse(hostId),
        ),
      ),
  getSession: async (input, hostId) =>
    desktopSessionSchema.parse(
      await ipcRenderer.invoke(
        'nesvo:get-session',
        getSessionSchema.parse(input),
        route(hostId),
      ),
    ),
  readSessionMessages: async (input, hostId) =>
    sessionMessagePageSchema.parse(
      await ipcRenderer.invoke(
        'nesvo:read-session-messages',
        readSessionMessagesSchema.parse(input),
        route(hostId),
      ),
    ),
  listReviews: async hostId =>
    desktopReviewSchema
      .array()
      .parse(
        await ipcRenderer.invoke(
          'nesvo:list-reviews',
          hostIdSchema.optional().parse(hostId),
        ),
      ),
  createSession: async (input, hostId) =>
    desktopSessionSchema.parse(
      await ipcRenderer.invoke(
        'nesvo:create-session',
        createSessionSchema.parse(input),
        route(hostId),
      ),
    ),
  readSessionWorktree: async (input, hostId) =>
    sessionWorktreeStatusSchema.parse(
      await ipcRenderer.invoke(
        'nesvo:read-session-worktree',
        readSessionWorktreeSchema.parse(input),
        route(hostId),
      ),
    ),
  finishSessionWorktree: async (input, hostId) =>
    desktopSessionSchema.parse(
      await ipcRenderer.invoke(
        'nesvo:finish-session-worktree',
        finishSessionWorktreeSchema.parse(input),
        route(hostId),
      ),
    ),
  readSessionWorktreeSetup: async (input, hostId) =>
    sessionWorktreeSetupSchema.parse(
      await ipcRenderer.invoke(
        'nesvo:read-session-worktree-setup',
        readSessionWorktreeSchema.parse(input),
        route(hostId),
      ),
    ),
  runSessionWorktreeSetup: async (input, hostId) =>
    sessionWorktreeSetupResultSchema.parse(
      await ipcRenderer.invoke(
        'nesvo:run-session-worktree-setup',
        runSessionWorktreeSetupSchema.parse(input),
        route(hostId),
      ),
    ),
  listOrphanedSessionWorktrees: async hostId =>
    orphanedSessionWorktreesSchema.parse(
      await ipcRenderer.invoke(
        'nesvo:list-orphaned-session-worktrees',
        route(hostId),
      ),
    ),
  removeOrphanedSessionWorktree: async (input, hostId) =>
    orphanedSessionWorktreeRemovalSchema.parse(
      await ipcRenderer.invoke(
        'nesvo:remove-orphaned-session-worktree',
        removeOrphanedSessionWorktreeSchema.parse(input),
        route(hostId),
      ),
    ),
  sendMessage: async (input, hostId) =>
    desktopSessionSchema.parse(
      await ipcRenderer.invoke(
        'nesvo:send-message',
        sendMessageSchema.parse(input),
        route(hostId),
      ),
    ),
  trustRepositoryMcp: async (input, hostId) =>
    mcpServerListSchema.parse(
      await ipcRenderer.invoke(
        'nesvo:trust-repository-mcp',
        trustRepositoryMcpSchema.parse(input),
        route(hostId),
      ),
    ),
  mcpConnections: async (input, hostId) =>
    mcpConnectionListSchema.parse(
      await ipcRenderer.invoke(
        'nesvo:mcp-connections',
        mcpConnectionRequestSchema.parse(input),
        route(hostId),
      ),
    ),
  openMcpTerminal: async input => {
    await ipcRenderer.invoke(
      'nesvo:open-mcp-terminal',
      mcpProfileTargetSchema.parse(input),
    );
  },
  listMcpServers: async (input, hostId) =>
    mcpServerListSchema.parse(
      await ipcRenderer.invoke(
        'nesvo:list-mcp-servers',
        listMcpServersSchema.parse(input),
        route(hostId),
      ),
    ),
  setSessionMcp: async (input, hostId) =>
    desktopSessionSchema.parse(
      await ipcRenderer.invoke(
        'nesvo:set-session-mcp',
        setSessionMcpSchema.parse(input),
        route(hostId),
      ),
    ),
  assignSessionWorkflow: async (input, hostId) =>
    desktopSessionSchema.parse(
      await ipcRenderer.invoke(
        'nesvo:assign-session-workflow',
        assignSessionWorkflowSchema.parse(input),
        route(hostId),
      ),
    ),
  forkSession: async (input, hostId) =>
    desktopSessionSchema.parse(
      await ipcRenderer.invoke(
        'nesvo:fork-session',
        forkSessionSchema.parse(input),
        route(hostId),
      ),
    ),
  restartSession: async (input, hostId) =>
    desktopSessionSchema.parse(
      await ipcRenderer.invoke(
        'nesvo:restart-session',
        restartSessionSchema.parse(input),
        route(hostId),
      ),
    ),
  resumeSession: async (input, hostId) =>
    desktopSessionSchema.parse(
      await ipcRenderer.invoke(
        'nesvo:resume-session',
        resumeSessionSchema.parse(input),
        route(hostId),
      ),
    ),
  readMergedWorktreeCleanup: async (input, hostId) =>
    mergedWorktreeCleanupSchema.parse(
      await ipcRenderer.invoke(
        'nesvo:read-merged-worktree-cleanup',
        readMergedWorktreeCleanupSchema.parse(input),
        route(hostId),
      ),
    ),
  finishMergedWorktree: async (input, hostId) =>
    mergedWorktreeFinishSchema.parse(
      await ipcRenderer.invoke(
        'nesvo:finish-merged-worktree',
        finishMergedWorktreeSchema.parse(input),
        route(hostId),
      ),
    ),
  compactSession: async (input, hostId) =>
    desktopSessionSchema.parse(
      await ipcRenderer.invoke(
        'nesvo:compact-session',
        compactSessionSchema.parse(input),
        route(hostId),
      ),
    ),
  listSessionGroups: async hostId =>
    sessionGroupListSchema.parse(
      await ipcRenderer.invoke('nesvo:list-session-groups', route(hostId)),
    ),
  createSessionGroup: async (input, hostId) =>
    sessionGroupListSchema.parse(
      await ipcRenderer.invoke(
        'nesvo:create-session-group',
        createSessionGroupSchema.parse(input),
        route(hostId),
      ),
    ),
  updateSessionGroup: async (input, hostId) =>
    sessionGroupListSchema.parse(
      await ipcRenderer.invoke(
        'nesvo:update-session-group',
        updateSessionGroupSchema.parse(input),
        route(hostId),
      ),
    ),
  moveSessionGroup: async (input, hostId) =>
    sessionGroupListSchema.parse(
      await ipcRenderer.invoke(
        'nesvo:move-session-group',
        moveSessionGroupSchema.parse(input),
        route(hostId),
      ),
    ),
  deleteSessionGroup: async (input, hostId) =>
    sessionGroupListSchema.parse(
      await ipcRenderer.invoke(
        'nesvo:delete-session-group',
        deleteSessionGroupSchema.parse(input),
        route(hostId),
      ),
    ),
  moveSession: async (input, hostId) =>
    desktopSessionSchema.parse(
      await ipcRenderer.invoke(
        'nesvo:move-session',
        moveSessionSchema.parse(input),
        route(hostId),
      ),
    ),
  renameSession: async (input, hostId) =>
    desktopSessionSchema.parse(
      await ipcRenderer.invoke(
        'nesvo:rename-session',
        renameSessionSchema.parse(input),
        route(hostId),
      ),
    ),
  setSessionPinned: async (input, hostId) =>
    desktopSessionSchema.parse(
      await ipcRenderer.invoke(
        'nesvo:set-session-pinned',
        setSessionPinnedSchema.parse(input),
        route(hostId),
      ),
    ),
  setSessionArchived: async (input, hostId) =>
    desktopSessionSchema.parse(
      await ipcRenderer.invoke(
        'nesvo:set-session-archived',
        setSessionArchivedSchema.parse(input),
        route(hostId),
      ),
    ),
  deleteSession: async (input, hostId) =>
    desktopSessionDeletionSchema.parse(
      await ipcRenderer.invoke(
        'nesvo:delete-session',
        deleteSessionSchema.parse(input),
        route(hostId),
      ),
    ),
  restoreSession: async (input, hostId) =>
    desktopSessionSchema.parse(
      await ipcRenderer.invoke(
        'nesvo:restore-session',
        restoreSessionSchema.parse(input),
        route(hostId),
      ),
    ),
  queueMessage: async (input, hostId) =>
    desktopSessionSchema.parse(
      await ipcRenderer.invoke(
        'nesvo:queue-message',
        sendMessageSchema.parse(input),
        route(hostId),
      ),
    ),
  cancelQueued: async (input, hostId) =>
    desktopSessionSchema.parse(
      await ipcRenderer.invoke(
        'nesvo:cancel-queued',
        queuedMessageRefSchema.parse(input),
        route(hostId),
      ),
    ),
  startQueued: async (input, hostId) =>
    desktopSessionSchema.parse(
      await ipcRenderer.invoke(
        'nesvo:start-queued',
        queuedMessageRefSchema.parse(input),
        route(hostId),
      ),
    ),
  stopRun: async (input, hostId) =>
    desktopSessionSchema.parse(
      await ipcRenderer.invoke(
        'nesvo:stop-run',
        stopRunSchema.parse(input),
        route(hostId),
      ),
    ),
  respondApproval: async (input, hostId) =>
    desktopSessionSchema.parse(
      await ipcRenderer.invoke(
        'nesvo:respond-approval',
        respondApprovalSchema.parse(input),
        route(hostId),
      ),
    ),
  decideDelegation: async (input, hostId) =>
    desktopSessionSchema.parse(
      await ipcRenderer.invoke(
        'nesvo:decide-delegation',
        decideDelegationSchema.parse(input),
        route(hostId),
      ),
    ),
  decideWorkerPlan: async (input, hostId) =>
    desktopSessionSchema.parse(
      await ipcRenderer.invoke(
        'nesvo:decide-worker-plan',
        decideWorkerPlanSchema.parse(input),
        route(hostId),
      ),
    ),
  continueWorker: async (input, hostId) =>
    desktopSessionSchema.parse(
      await ipcRenderer.invoke(
        'nesvo:continue-worker',
        continueWorkerSchema.parse(input),
        route(hostId),
      ),
    ),
  continueCoordinator: async (input, hostId) =>
    desktopSessionSchema.parse(
      await ipcRenderer.invoke(
        'nesvo:continue-coordinator',
        continueCoordinatorSchema.parse(input),
        route(hostId),
      ),
    ),
  workerWorktree: async (input, hostId) =>
    workerWorktreeResultSchema.parse(
      await ipcRenderer.invoke(
        'nesvo:worker-worktree',
        workerWorktreeInputSchema.parse(input),
        route(hostId),
      ),
    ),
  decideSessionParent: async (input, hostId) =>
    desktopSessionSchema.parse(
      await ipcRenderer.invoke(
        'nesvo:decide-session-parent',
        decideSessionParentSchema.parse(input),
        route(hostId),
      ),
    ),
  decideSessionPlan: async (input, hostId) =>
    desktopSessionSchema.parse(
      await ipcRenderer.invoke(
        'nesvo:decide-session-plan',
        decideSessionPlanSchema.parse(input),
        route(hostId),
      ),
    ),
  answerSessionQuestion: async (input, hostId) =>
    desktopSessionSchema.parse(
      await ipcRenderer.invoke(
        'nesvo:answer-session-question',
        answerSessionQuestionSchema.parse(input),
        route(hostId),
      ),
    ),
  gateRules: async (input, hostId) =>
    gateRuleOverviewSchema.parse(
      await ipcRenderer.invoke(
        'nesvo:gate-rules',
        gateRulesInputSchema.parse(input),
        route(hostId),
      ),
    ),
  readLessons: async hostId =>
    lessonOverviewSchema.parse(
      await ipcRenderer.invoke('nesvo:read-lessons', route(hostId)),
    ),
  saveLessonSettings: async (settings, hostId) =>
    lessonOverviewSchema.parse(
      await ipcRenderer.invoke(
        'nesvo:save-lesson-settings',
        lessonSettingsSchema.parse(settings),
        route(hostId),
      ),
    ),
  proposeLessons: async (input, hostId) =>
    lessonOverviewSchema.parse(
      await ipcRenderer.invoke(
        'nesvo:propose-lessons',
        proposeLessonsSchema.parse(input),
        route(hostId),
      ),
    ),
  decideLesson: async (input, hostId) =>
    lessonOverviewSchema.parse(
      await ipcRenderer.invoke(
        'nesvo:decide-lesson',
        decideLessonSchema.parse(input),
        route(hostId),
      ),
    ),
  readCoordinatorWake: async (input, hostId) =>
    coordinatorWakeStateSchema.parse(
      await ipcRenderer.invoke(
        'nesvo:read-coordinator-wake',
        coordinatorWakeTargetSchema.parse(input),
        route(hostId),
      ),
    ),
  setCoordinatorWake: async (input, hostId) =>
    coordinatorWakeStateSchema.parse(
      await ipcRenderer.invoke(
        'nesvo:set-coordinator-wake',
        setCoordinatorWakeSchema.parse(input),
        route(hostId),
      ),
    ),
  continueCoordinatorDelivery: async (input, hostId) =>
    coordinatorDeliveryReceiptSchema.parse(
      await ipcRenderer.invoke(
        'nesvo:continue-coordinator-delivery',
        continueCoordinatorDeliverySchema.parse(input),
        route(hostId),
      ),
    ),
  steerChildSession: async (input, hostId) =>
    sessionSteerResultSchema.parse(
      await ipcRenderer.invoke(
        'nesvo:steer-child-session',
        ownerSteerInputSchema.parse(input),
        route(hostId),
      ),
    ),
  decideChildSteering: async (input, hostId) =>
    sessionSteerResultSchema.parse(
      await ipcRenderer.invoke(
        'nesvo:decide-child-steering',
        decideSteeringInputSchema.parse(input),
        route(hostId),
      ),
    ),
  readChildWork: async (input, hostId) =>
    childWorkPageSchema.parse(
      await ipcRenderer.invoke(
        'nesvo:read-child-work',
        ownerChildWorkInputSchema.parse(input),
        route(hostId),
      ),
    ),
  readSessionControlPolicy: async hostId =>
    coordinatorPolicySchema.parse(
      await ipcRenderer.invoke(
        'nesvo:read-session-control-policy',
        route(hostId),
      ),
    ),
  saveSessionControlPolicy: async (policy, hostId) =>
    coordinatorPolicySchema.parse(
      await ipcRenderer.invoke(
        'nesvo:save-session-control-policy',
        coordinatorPolicySchema.parse(policy),
        route(hostId),
      ),
    ),
  decideReview: async (input, hostId) =>
    desktopReviewSchema.parse(
      await ipcRenderer.invoke(
        'nesvo:decide-review',
        decideReviewSchema.parse(input),
        route(hostId),
      ),
    ),
  discoverSkills: async (input, hostId) =>
    skillCatalogSchema.parse(
      await ipcRenderer.invoke(
        'nesvo:discover-skills',
        discoverSkillsSchema.parse(input),
        route(hostId),
      ),
    ),
  listClaudeCommands: async (input, hostId) =>
    claudeCommandListSchema.parse(
      await ipcRenderer.invoke(
        'nesvo:list-claude-commands',
        listClaudeCommandsSchema.parse(input),
        route(hostId),
      ),
    ),
  listPullRequests: async (input, hostId) =>
    pullRequestListSchema.parse(
      await ipcRenderer.invoke(
        'nesvo:list-pull-requests',
        listPullRequestsSchema.parse(input),
        route(hostId),
      ),
    ),
  listInboxRules: async (input, hostId) =>
    inboxRuleCatalogSchema.parse(
      await ipcRenderer.invoke(
        'nesvo:list-inbox-rules',
        listInboxRulesSchema.parse(input),
        route(hostId),
      ),
    ),
  validateInboxRule: async (input, hostId) =>
    inboxRuleValidationSchema.parse(
      await ipcRenderer.invoke(
        'nesvo:validate-inbox-rule',
        validateInboxRuleSchema.parse(input),
        route(hostId),
      ),
    ),
  saveInboxRule: async (input, hostId) =>
    inboxRuleCatalogSchema.parse(
      await ipcRenderer.invoke(
        'nesvo:save-inbox-rule',
        saveInboxRuleSchema.parse(input),
        route(hostId),
      ),
    ),
  deleteInboxRule: async (input, hostId) =>
    inboxRuleCatalogSchema.parse(
      await ipcRenderer.invoke(
        'nesvo:delete-inbox-rule',
        deleteInboxRuleSchema.parse(input),
        route(hostId),
      ),
    ),
  setInboxRuleEnabled: async (input, hostId) =>
    inboxRuleCatalogSchema.parse(
      await ipcRenderer.invoke(
        'nesvo:set-inbox-rule-enabled',
        setInboxRuleEnabledSchema.parse(input),
        route(hostId),
      ),
    ),
  proposeInboxRule: async (input, hostId) =>
    inboxRuleProposalSchema.parse(
      await ipcRenderer.invoke(
        'nesvo:propose-inbox-rule',
        proposeInboxRuleSchema.parse(input),
        route(hostId),
      ),
    ),
  listInboxItems: async hostId =>
    inboxItemSchema
      .array()
      .parse(await ipcRenderer.invoke('nesvo:list-inbox-items', route(hostId))),
  listExternalInboxDevices: async hostId =>
    externalInboxDevicesSchema.parse(
      await ipcRenderer.invoke(
        'nesvo:list-external-inbox-devices',
        route(hostId),
      ),
    ),
  enrollExternalInboxDevice: async (input, hostId) =>
    externalInboxEnrollmentSchema.parse(
      await ipcRenderer.invoke(
        'nesvo:enroll-external-inbox-device',
        externalInboxDeviceNameSchema.parse(input),
        route(hostId),
      ),
    ),
  readInboxCliInstallation: async () =>
    inboxCliInstallationSchema
      .nullable()
      .parse(await ipcRenderer.invoke('nesvo:read-inbox-cli-installation')),
  revokeExternalInboxDevice: async (input, hostId) =>
    externalInboxDevicesSchema.parse(
      await ipcRenderer.invoke(
        'nesvo:revoke-external-inbox-device',
        externalInboxDeviceIdSchema.parse(input),
        route(hostId),
      ),
    ),
  decideInboxItem: async (input, hostId) =>
    inboxItemSchema.parse(
      await ipcRenderer.invoke(
        'nesvo:decide-inbox-item',
        decideInboxItemSchema.parse(input),
        route(hostId),
      ),
    ),
  readInboxSettings: async hostId =>
    inboxSettingsSchema.parse(
      await ipcRenderer.invoke('nesvo:read-inbox-settings', route(hostId)),
    ),
  saveInboxSettings: async (settings, hostId) =>
    inboxSettingsSchema.parse(
      await ipcRenderer.invoke(
        'nesvo:save-inbox-settings',
        inboxSettingsSchema.parse(settings),
        route(hostId),
      ),
    ),
  listRunningApps: async (hostId, query) =>
    runningAppListSchema.parse(
      await ipcRenderer.invoke('nesvo:list-running-apps', route(hostId), query),
    ),
  claudeAutonomy: async (input, hostId) =>
    claudeAutonomySchema.parse(
      await ipcRenderer.invoke(
        'nesvo:claude-autonomy',
        claudeAutonomyInputSchema.parse(input),
        hostIdSchema.optional().parse(hostId),
      ),
    ),
  repositoryTrustSettings: async (input, hostId) =>
    repositoryTrustSettingsSchema.parse(
      await ipcRenderer.invoke(
        'nesvo:repository-trust-settings',
        repositoryTrustSettingsInputSchema.parse(input),
        hostIdSchema.optional().parse(hostId),
      ),
    ),
  readDefaultSessionFolder: async hostId =>
    defaultSessionFolderSchema.parse(
      await ipcRenderer.invoke(
        'nesvo:read-default-session-folder',
        route(hostId),
      ),
    ),
  customWorktreeProviders: async (input, hostId) =>
    worktreeProviderReplySchema.parse(
      await ipcRenderer.invoke(
        'nesvo:custom-worktree-providers',
        worktreeProviderInputSchema.parse(input),
        hostIdSchema.optional().parse(hostId),
      ),
    ),
  providerUsageGates: async (input, hostId) =>
    providerUsageGateSettingsSchema.parse(
      await ipcRenderer.invoke(
        'nesvo:provider-usage-gates',
        providerUsageGateInputSchema.parse(input),
        hostIdSchema.optional().parse(hostId),
      ),
    ),
  readonlyIntegrationGrants: async (input, hostId) =>
    readonlyIntegrationReplySchema.parse(
      await ipcRenderer.invoke(
        'nesvo:readonly-integration-grants',
        readonlyIntegrationInputSchema.parse(input),
        hostIdSchema.optional().parse(hostId),
      ),
    ),
  externalSessionMessages: async (input, hostId) =>
    externalSessionSettingsSchema.parse(
      await ipcRenderer.invoke(
        'nesvo:external-session-messages',
        externalSessionSettingsInputSchema.parse(input),
        hostIdSchema.optional().parse(hostId),
      ),
    ),
  sessionMessageWatchers: async (input, hostId) =>
    sessionMessageWatcherReplySchema.parse(
      await ipcRenderer.invoke(
        'nesvo:session-message-watchers',
        sessionMessageWatcherInputSchema.parse(input),
        hostIdSchema.optional().parse(hostId),
      ),
    ),
  setDefaultSessionFolder: async (directory, hostId) =>
    defaultSessionFolderSchema.parse(
      await ipcRenderer.invoke(
        'nesvo:set-default-session-folder',
        setDefaultSessionFolderSchema.parse({ directory }),
        route(hostId),
      ),
    ),
  listWorktreeRecipes: async hostId =>
    worktreeRecipeListSchema.parse(
      await ipcRenderer.invoke('nesvo:list-worktree-recipes', route(hostId)),
    ),
  saveWorktreeRecipe: async (input, hostId) =>
    worktreeRecipeListSchema.parse(
      await ipcRenderer.invoke(
        'nesvo:save-worktree-recipe',
        saveWorktreeRecipeSchema.parse(input),
        route(hostId),
      ),
    ),
  deleteWorktreeRecipe: async (input, hostId) =>
    worktreeRecipeListSchema.parse(
      await ipcRenderer.invoke(
        'nesvo:delete-worktree-recipe',
        deleteWorktreeRecipeSchema.parse(input),
        route(hostId),
      ),
    ),
  matchWorktreeRecipe: async (input, hostId) =>
    worktreeRecipeMatchSchema.parse(
      await ipcRenderer.invoke(
        'nesvo:match-worktree-recipe',
        matchWorktreeRecipeSchema.parse(input),
        route(hostId),
      ),
    ),
  startWorktreeRecipeTrial: async (input, hostId) =>
    worktreeRecipeRunSchema
      .nullable()
      .parse(
        await ipcRenderer.invoke(
          'nesvo:start-worktree-recipe-trial',
          startWorktreeRecipeTrialSchema.parse(input),
          route(hostId),
        ),
      ),
  readWorktreeRecipeTrial: async (input, hostId) =>
    worktreeRecipeRunSchema
      .nullable()
      .parse(
        await ipcRenderer.invoke(
          'nesvo:read-worktree-recipe-trial',
          worktreeRecipeTrialRefSchema.parse(input),
          route(hostId),
        ),
      ),
  stopWorktreeRecipeTrial: async (input, hostId) =>
    worktreeRecipeRunSchema
      .nullable()
      .parse(
        await ipcRenderer.invoke(
          'nesvo:stop-worktree-recipe-trial',
          worktreeRecipeTrialRefSchema.parse(input),
          route(hostId),
        ),
      ),
  readSessionWorktreeRecipe: async (input, hostId) =>
    worktreeRecipeRunSchema
      .nullable()
      .parse(
        await ipcRenderer.invoke(
          'nesvo:read-session-worktree-recipe',
          readSessionWorktreeRecipeSchema.parse(input),
          route(hostId),
        ),
      ),
  decideSessionWorktreeRecipe: async (input, hostId) =>
    worktreeRecipeRunSchema
      .nullable()
      .parse(
        await ipcRenderer.invoke(
          'nesvo:decide-session-worktree-recipe',
          decideSessionWorktreeRecipeSchema.parse(input),
          route(hostId),
        ),
      ),
  listTrackedRepositories: async hostId =>
    trackedRepositoryListSchema.parse(
      await ipcRenderer.invoke(
        'nesvo:list-tracked-repositories',
        route(hostId),
      ),
    ),
  addTrackedRepository: async (input, hostId) =>
    trackedRepositoryListSchema.parse(
      await ipcRenderer.invoke(
        'nesvo:add-tracked-repository',
        addTrackedRepositorySchema.parse(input),
        route(hostId),
      ),
    ),
  removeTrackedRepository: async (input, hostId) =>
    trackedRepositoryListSchema.parse(
      await ipcRenderer.invoke(
        'nesvo:remove-tracked-repository',
        removeTrackedRepositorySchema.parse(input),
        route(hostId),
      ),
    ),
  reorderTrackedRepositories: async (input, hostId) =>
    trackedRepositoryListSchema.parse(
      await ipcRenderer.invoke(
        'nesvo:reorder-tracked-repositories',
        reorderTrackedRepositoriesSchema.parse(input),
        route(hostId),
      ),
    ),
  suggestTrackedRepositories: async hostId =>
    trackedRepositorySuggestionListSchema.parse(
      await ipcRenderer.invoke(
        'nesvo:suggest-tracked-repositories',
        route(hostId),
      ),
    ),
  listTrackedPullRequests: async (input, hostId) =>
    trackedPullRequestListsSchema.parse(
      await ipcRenderer.invoke(
        'nesvo:list-tracked-pull-requests',
        listTrackedPullRequestsSchema.parse(input),
        route(hostId),
      ),
    ),
  readPullRequest: async (input, hostId) =>
    pullRequestSchema.parse(
      await ipcRenderer.invoke(
        'nesvo:read-pull-request',
        readPullRequestSchema.parse(input),
        route(hostId),
      ),
    ),
  readPullRequestFiles: async (input, hostId) =>
    pullRequestFilesSchema.parse(
      await ipcRenderer.invoke(
        'nesvo:read-pull-request-files',
        readPullRequestSchema.parse(input),
        route(hostId),
      ),
    ),
  readPullRequestThreads: async (input, hostId) =>
    pullRequestThreadsSchema.parse(
      await ipcRenderer.invoke(
        'nesvo:read-pull-request-threads',
        readPullRequestSchema.parse(input),
        route(hostId),
      ),
    ),
  actOnPullRequest: async (input, hostId) =>
    pullRequestActionResultSchema.parse(
      await ipcRenderer.invoke(
        'nesvo:act-on-pull-request',
        actOnPullRequestSchema.parse(input),
        route(hostId),
      ),
    ),
  linkSessionPullRequest: async (input, hostId) =>
    desktopSessionSchema.parse(
      await ipcRenderer.invoke(
        'nesvo:link-session-pull-request',
        linkSessionPullRequestSchema.parse(input),
        route(hostId),
      ),
    ),
  findSessionPullRequest: async (input, hostId) =>
    pullRequestReferenceSchema
      .nullable()
      .parse(
        await ipcRenderer.invoke(
          'nesvo:find-session-pull-request',
          findSessionPullRequestSchema.parse(input),
          route(hostId),
        ),
      ),
  readGitBranch: async (input, hostId) =>
    gitBranchSchema.parse(
      await ipcRenderer.invoke(
        'nesvo:read-git-branch',
        readGitBranchSchema.parse(input),
        route(hostId),
      ),
    ),
  listManagerImport: async (input, hostId) =>
    managerImportCatalogSchema.parse(
      await ipcRenderer.invoke(
        'nesvo:list-manager-import',
        listManagerImportSchema.parse(input),
        route(hostId),
      ),
    ),
  adoptManagerImport: async (input, hostId) =>
    managerImportResultSchema.parse(
      await ipcRenderer.invoke(
        'nesvo:adopt-manager-import',
        adoptManagerImportSchema.parse(input),
        route(hostId),
      ),
    ),
  listConversations: async (input, hostId) =>
    conversationImportCatalogSchema.parse(
      await ipcRenderer.invoke(
        'nesvo:list-conversations',
        route(hostId),
        input === undefined ? undefined : listConversationsSchema.parse(input),
      ),
    ),
  adoptConversation: async (input, hostId) =>
    desktopSessionSchema.parse(
      await ipcRenderer.invoke(
        'nesvo:adopt-conversation',
        adoptConversationSchema.parse(input),
        route(hostId),
      ),
    ),
  searchTranscripts: async (input, hostId) =>
    transcriptSearchPageSchema.parse(
      await ipcRenderer.invoke(
        'nesvo:search-transcripts',
        transcriptSearchInputSchema.parse(input),
        route(hostId),
      ),
    ),
  openSessionInTerminal: async (input, hostId) =>
    openedSessionTerminalSchema.parse(
      await ipcRenderer.invoke(
        'nesvo:open-session-terminal',
        openSessionTerminalSchema.parse(input),
        route(hostId),
      ),
    ),
  setSessionTerminal: async (input, hostId) =>
    desktopSessionSchema.parse(
      await ipcRenderer.invoke(
        'nesvo:set-session-terminal',
        setSessionTerminalSchema.parse(input),
        route(hostId),
      ),
    ),
  searchHistory: async (input, hostId) =>
    historySearchPageSchema.parse(
      await ipcRenderer.invoke(
        'nesvo:search-history',
        historySearchInputSchema.parse(input),
        route(hostId),
      ),
    ),
  listWorkspaceDirectory: async (input, hostId) =>
    workspaceDirectorySchema.parse(
      await ipcRenderer.invoke(
        'nesvo:list-workspace-directory',
        listWorkspaceDirectorySchema.parse(input),
        route(hostId),
      ),
    ),
  searchWorkspaceFiles: async (input, hostId) =>
    workspaceSearchSchema.parse(
      await ipcRenderer.invoke(
        'nesvo:search-workspace-files',
        searchWorkspaceFilesSchema.parse(input),
        route(hostId),
      ),
    ),
  readWorkspaceFile: async (input, hostId) =>
    workspaceFileSchema.parse(
      await ipcRenderer.invoke(
        'nesvo:read-workspace-file',
        readWorkspaceFileSchema.parse(input),
        route(hostId),
      ),
    ),
  readSessionChanges: async (input, hostId) =>
    sessionChangesSchema.parse(
      await ipcRenderer.invoke(
        'nesvo:read-session-changes',
        readSessionChangesSchema.parse(input),
        route(hostId),
      ),
    ),
  readSessionChangePatch: async (input, hostId) =>
    sessionChangePatchSchema.parse(
      await ipcRenderer.invoke(
        'nesvo:read-session-change-patch',
        readSessionChangePatchSchema.parse(input),
        route(hostId),
      ),
    ),
  stageAttachment: async (input, hostId) =>
    attachmentUploadSchema.parse(
      await ipcRenderer.invoke(
        'nesvo:stage-attachment',
        stageAttachmentSchema.parse(input),
        route(hostId),
      ),
    ),
  openAttachment: async (input, hostId) => {
    await ipcRenderer.invoke(
      'nesvo:open-attachment',
      openAttachmentSchema.parse(input),
      route(hostId),
    );
  },
  readAttachment: async (input, hostId) =>
    attachmentContentSchema.parse(
      await ipcRenderer.invoke(
        'nesvo:read-attachment',
        readAttachmentSchema.parse(input),
        route(hostId),
      ),
    ),
  subscribe: listener => {
    const receive = (_event: Electron.IpcRendererEvent, payload: unknown) => {
      const parsed = workspaceEventSchema.safeParse(payload);
      if (parsed.success) listener(parsed.data);
      else reportDroppedEvent(payload, parsed.error.message);
    };
    ipcRenderer.on('nesvo:event', receive);
    return () => ipcRenderer.removeListener('nesvo:event', receive);
  },
};
contextBridge.exposeInMainWorld('nesvo', api);

async function invoke(channel: string, ...args: unknown[]): Promise<unknown> {
  const result = (await electronIpcRenderer.invoke(channel, ...args)) as
    { ok: true; value: unknown } | { ok: false; message: string };
  if (!result.ok) throw new Error(result.message);
  return result.value;
}
