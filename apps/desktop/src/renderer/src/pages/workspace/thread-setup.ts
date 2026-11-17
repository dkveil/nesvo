import { providers } from '@/entities/session';
import type { ThreadSetup } from '@/features/new-thread';

type RememberedSetup = Omit<ThreadSetup, 'hostId'>;

const key = 'nesvo.thread-setup.v1';
const maxLength = 4096;

const text = (value: unknown, limit = maxLength): value is string =>
  typeof value === 'string' && value.length <= limit;

const remembered = (value: unknown): RememberedSetup | null => {
  if (!value || typeof value !== 'object') return null;
  const saved = value as Record<string, unknown>;
  const provider = providers.find(item => item === saved.provider);
  if (
    !provider ||
    !text(saved.directory) ||
    !text(saved.model, 256) ||
    !text(saved.effort, 64) ||
    !text(saved.mode, 64)
  )
    return null;
  return {
    directory: saved.directory,
    provider,
    model: saved.model,
    effort: saved.effort,
    mode: saved.mode as ThreadSetup['mode'],
  };
};

const readAll = (): Record<string, unknown> => {
  try {
    const raw = localStorage.getItem(key);
    if (!raw || raw.length > 65536) return {};
    const value: unknown = JSON.parse(raw);
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
};

export const readThreadSetup = (hostId: string): ThreadSetup | null => {
  const setup = remembered(readAll()[hostId]);
  return setup ? { hostId, ...setup } : null;
};

export const saveThreadSetup = ({ hostId, ...setup }: ThreadSetup): void => {
  try {
    localStorage.setItem(
      key,
      JSON.stringify({ ...readAll(), [hostId]: setup }),
    );
  } catch {
    return;
  }
};
