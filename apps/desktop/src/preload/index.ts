import { contextBridge, ipcRenderer } from 'electron';
import { hostHealthSchema, type DesktopApi } from '@nesvo/contracts';

const api: DesktopApi = {
  health: async () =>
    hostHealthSchema.parse(await ipcRenderer.invoke('nesvo:health')),
};
contextBridge.exposeInMainWorld('nesvo', api);
