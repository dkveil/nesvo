import { contextBridge, ipcRenderer } from 'electron';
import {
  claudeStatusSchema,
  createSessionSchema,
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
  listSessions: async () =>
    sessionSchema
      .array()
      .parse(await ipcRenderer.invoke('nesvo:list-sessions')),
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
