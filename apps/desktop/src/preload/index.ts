import { contextBridge, ipcRenderer } from 'electron';
import {
  claudeStatusSchema,
  codexStatusSchema,
  respondApprovalSchema,
  createSessionSchema,
  decideDelegationSchema,
  decideReviewSchema,
  reviewSchema,
  desktopEventSchema,
  hostHealthSchema,
  sendMessageSchema,
  sessionSchema,
  stopRunSchema,
  type DesktopApi,
} from '@nesvo/contracts';

const api: DesktopApi = {
  health: async () =>
    hostHealthSchema.parse(await ipcRenderer.invoke('nesvo:health')),
  claudeStatus: async () =>
    claudeStatusSchema.parse(await ipcRenderer.invoke('nesvo:claude-status')),
  codexStatus: async () =>
    codexStatusSchema.parse(await ipcRenderer.invoke('nesvo:codex-status')),
  decideDelegation: async input =>
    sessionSchema.parse(
      await ipcRenderer.invoke(
        'nesvo:decide-delegation',
        decideDelegationSchema.parse(input),
      ),
    ),
  respondApproval: async input =>
    sessionSchema.parse(
      await ipcRenderer.invoke(
        'nesvo:respond-approval',
        respondApprovalSchema.parse(input),
      ),
    ),
  listSessions: async () =>
    sessionSchema
      .array()
      .parse(await ipcRenderer.invoke('nesvo:list-sessions')),
  listReviews: async () =>
    reviewSchema.array().parse(await ipcRenderer.invoke('nesvo:list-reviews')),
  decideReview: async input =>
    reviewSchema.parse(
      await ipcRenderer.invoke(
        'nesvo:decide-review',
        decideReviewSchema.parse(input),
      ),
    ),
  createSession: async input =>
    sessionSchema.parse(
      await ipcRenderer.invoke(
        'nesvo:create-session',
        createSessionSchema.parse(input),
      ),
    ),
  sendMessage: async input =>
    sessionSchema.parse(
      await ipcRenderer.invoke(
        'nesvo:send-message',
        sendMessageSchema.parse(input),
      ),
    ),
  stopRun: async input =>
    sessionSchema.parse(
      await ipcRenderer.invoke('nesvo:stop-run', stopRunSchema.parse(input)),
    ),
  subscribe: listener => {
    const receive = (_event: Electron.IpcRendererEvent, payload: unknown) => {
      const parsed = desktopEventSchema.safeParse(payload);
      if (parsed.success) listener(parsed.data);
    };
    ipcRenderer.on('nesvo:event', receive);
    return () => ipcRenderer.removeListener('nesvo:event', receive);
  },
};
contextBridge.exposeInMainWorld('nesvo', api);
