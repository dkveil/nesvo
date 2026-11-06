import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

export const callHost = <TResult>(command: string, args?: Record<string, unknown>) =>
  invoke<TResult>(command, args);

export const subscribeHost = <TPayload>(event: string, handler: (payload: TPayload) => void) =>
  listen<TPayload>(event, message => handler(message.payload));
