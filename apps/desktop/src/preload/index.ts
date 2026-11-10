import { contextBridge, ipcRenderer } from 'electron';
import {
  claudeStatusSchema,
  codexStatusSchema,
  respondApprovalSchema,
  createSessionSchema,
  decideDelegationSchema,
  decideReviewSchema,
  hostHealthSchema,
  sendMessageSchema,
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
  type DesktopApi,
} from '@nesvo/contracts';

const route = (hostId: string | undefined) =>
  hostIdSchema.parse(hostId ?? 'local');
const api: DesktopApi = {
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
