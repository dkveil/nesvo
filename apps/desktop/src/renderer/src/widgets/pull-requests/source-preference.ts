const SOURCE_KEY = 'nesvo.pull-requests.source.v1';
const EXCLUDED_KEY = 'nesvo.pull-requests.excluded-repositories.v1';
const MAX_EXCLUDED_REPOSITORIES = 100;

const readRecord = (key: string): Record<string, unknown> => {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(key) ?? '{}');
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
};

const saveRecordEntry = (key: string, hostId: string, value: unknown) => {
  try {
    localStorage.setItem(
      key,
      JSON.stringify({ ...readRecord(key), [hostId]: value }),
    );
  } catch {
    return;
  }
};

export const readSourcePreference = (hostId: string): string | null => {
  const value = readRecord(SOURCE_KEY)[hostId];
  return typeof value === 'string' ? value : null;
};

export const saveSourcePreference = (hostId: string, source: string) =>
  saveRecordEntry(SOURCE_KEY, hostId, source);

export const readExcludedRepositories = (hostId: string): string[] => {
  const value = readRecord(EXCLUDED_KEY)[hostId];
  return Array.isArray(value)
    ? value
        .filter((item): item is string => typeof item === 'string')
        .slice(0, MAX_EXCLUDED_REPOSITORIES)
    : [];
};

export const saveExcludedRepositories = (
  hostId: string,
  repositories: string[],
) =>
  saveRecordEntry(
    EXCLUDED_KEY,
    hostId,
    repositories.slice(0, MAX_EXCLUDED_REPOSITORIES),
  );
