import { contextBridge, ipcRenderer } from 'electron';
import {
  claudeStatusSchema,
  codexStatusSchema,
  colorSchemeSchema,
  appliedColorSchemeSchema,
  respondApprovalSchema,
  answerPromptSchema,
  createSessionSchema,
  decideDelegationSchema,
  decideWorkerPlanSchema,
  decideReviewSchema,
  hostHealthSchema,
  assignSessionWorkflowSchema,
  sendMessageSchema,
  queuedMessageRefSchema,
  stopRunSchema,
  listWorkspaceDirectorySchema,
  searchWorkspaceFilesSchema,
  readWorkspaceFileSchema,
  readGitBranchSchema,
  gitBranchSchema,
  workspaceDirectorySchema,
  workspaceSearchSchema,
  workspaceFileSchema,
  discoverSkillsSchema,
  skillCatalogSchema,
  computerSchema,
  desktopSessionSchema,
  desktopReviewSchema,
  hostIdSchema,
  sshComputerInputSchema,
  workspaceEventSchema,
  providerUsageInputSchema,
  providerUsageSchema,
  mobileDeviceSchema,
  mobileGatewayStatusSchema,
  mobilePairingSchema,
  desktopScheduledJobSchema,
  desktopScheduledJobRunSchema,
  desktopScheduledJobRunPageSchema,
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
} from '@nesvo/contracts';

const launchColorScheme = appliedColorSchemeSchema.safeParse(
  process.argv
    .find(argument => argument.startsWith('--nesvo-color-scheme='))
    ?.split('=')[1],
);
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
  listRuns: async (hostId, id, cursor) =>
    desktopScheduledJobRunPageSchema.parse(
      await ipcRenderer.invoke(
        'nesvo:list-scheduled-job-runs',
        listScheduledJobRunsSchema.parse({ scheduledJobId: id, cursor }),
        hostIdSchema.parse(hostId),
      ),
    ),
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
  scheduledJobs,
  workflows,
  colorScheme: async () =>
    colorSchemeSchema.parse(await ipcRenderer.invoke('nesvo:color-scheme')),
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
  providerUsage: async (input, hostId) =>
    providerUsageSchema.parse(
      await ipcRenderer.invoke(
        'nesvo:provider-usage',
        providerUsageInputSchema.parse(input),
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
  claudeStatus: async hostId =>
    claudeStatusSchema.parse(
      await ipcRenderer.invoke('nesvo:claude-status', route(hostId)),
    ),
  codexStatus: async hostId =>
    codexStatusSchema.parse(
      await ipcRenderer.invoke('nesvo:codex-status', route(hostId)),
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
  sendMessage: async (input, hostId) =>
    desktopSessionSchema.parse(
      await ipcRenderer.invoke(
        'nesvo:send-message',
        sendMessageSchema.parse(input),
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
  answerPrompt: async (input, hostId) =>
    desktopSessionSchema.parse(
      await ipcRenderer.invoke(
        'nesvo:answer-prompt',
        answerPromptSchema.parse(input),
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
  readGitBranch: async (input, hostId) =>
    gitBranchSchema.parse(
      await ipcRenderer.invoke(
        'nesvo:read-git-branch',
        readGitBranchSchema.parse(input),
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
  subscribe: listener => {
    const receive = (_event: Electron.IpcRendererEvent, payload: unknown) => {
      const parsed = workspaceEventSchema.safeParse(payload);
      if (parsed.success) listener(parsed.data);
    };
    ipcRenderer.on('nesvo:event', receive);
    return () => ipcRenderer.removeListener('nesvo:event', receive);
  },
};
contextBridge.exposeInMainWorld('nesvo', api);
