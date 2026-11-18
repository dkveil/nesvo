import {
  providerProfileSelectionSchema,
  providerSchema,
  sessionModeSchema,
} from '@nesvo/contracts';
import type { Provider } from '@/entities/session';
import type { ThreadSetup } from './index';

const key = 'nesvo.new-session-defaults.v1';
const MAX_MODEL_ID_LENGTH = 200;
const MAX_DIRECTORY_LENGTH = 4096;

export type NewSessionDefaults = {
  provider: Provider | null;
  profileIds: Record<string, string | null>;
  model: string | null;
  mode: ThreadSetup['mode'] | null;
  directory: string;
  worktree: boolean;
};

export const emptyNewSessionDefaults: NewSessionDefaults = {
  provider: null,
  profileIds: {},
  model: null,
  mode: null,
  directory: '',
  worktree: false,
};

export function defaultProfileKey(hostId: string, provider: Provider) {
  return JSON.stringify([hostId, provider]);
}

function parseDefaults(value: unknown): NewSessionDefaults {
  if (typeof value !== 'object' || value === null)
    return emptyNewSessionDefaults;
  const stored = value as Record<string, unknown>;
  const provider = providerSchema.safeParse(stored.provider);
  const mode = sessionModeSchema.safeParse(stored.mode);
  const profileIds: NewSessionDefaults['profileIds'] = {};
  if (stored.profileIds && typeof stored.profileIds === 'object') {
    for (const [host, profileId] of Object.entries(stored.profileIds)) {
      const parsed = providerProfileSelectionSchema.safeParse({ profileId });
      if (parsed.success && parsed.data.profileId !== undefined)
        profileIds[host] = parsed.data.profileId;
    }
  }
  return {
    provider: provider.success ? provider.data : null,
    profileIds,
    model:
      typeof stored.model === 'string' &&
      stored.model.length > 0 &&
      stored.model.length <= MAX_MODEL_ID_LENGTH
        ? stored.model
        : null,
    mode: mode.success ? mode.data : null,
    directory:
      typeof stored.directory === 'string' &&
      stored.directory.length <= MAX_DIRECTORY_LENGTH
        ? stored.directory
        : '',
    worktree: stored.worktree === true,
  };
}

export function readNewSessionDefaults(): NewSessionDefaults {
  try {
    const stored = localStorage.getItem(key);
    return stored ? parseDefaults(JSON.parse(stored)) : emptyNewSessionDefaults;
  } catch {
    return emptyNewSessionDefaults;
  }
}

export function saveNewSessionDefaults(defaults: NewSessionDefaults): void {
  try {
    localStorage.setItem(key, JSON.stringify(defaults));
  } catch {
    return;
  }
}

export function applyNewSessionDefaults(
  setup: ThreadSetup,
  defaults: NewSessionDefaults = readNewSessionDefaults(),
  computerFolder: string | null = null,
): ThreadSetup {
  const provider = defaults.provider ?? setup.provider;
  const switched = provider !== setup.provider;
  return {
    ...setup,
    provider,
    profileId:
      defaults.profileIds[defaultProfileKey(setup.hostId, provider)] ?? null,
    model:
      defaults.provider && defaults.model
        ? defaults.model
        : switched
          ? ''
          : setup.model,
    effort:
      switched || (defaults.provider && defaults.model) ? '' : setup.effort,
    mode:
      defaults.provider && defaults.mode
        ? defaults.mode
        : switched
          ? 'read-only'
          : setup.mode,
    directory: computerFolder || defaults.directory.trim() || setup.directory,
  };
}
