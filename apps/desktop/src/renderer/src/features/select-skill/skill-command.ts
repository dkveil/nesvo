import type { SkillCatalog, SkillEntry } from '@nesvo/contracts';

export const sourceLabels: Record<SkillEntry['source'], string> = {
  project: 'Project',
  user: 'Personal',
  system: 'Built-in',
  managed: 'Managed',
  plugin: 'Plugin',
  unknown: 'Unknown source',
};

const typedCommandPattern = /^\/([\w.:-]+)(?:\s+([\s\S]*))?$/;

export const slashQueryOf = (draft: string) => /^\/(\S*)$/.exec(draft)?.[1];

export const skillCommand = (skill: Pick<SkillEntry, 'name'>) =>
  skill.name
    .trim()
    .toLowerCase()
    .replace(/[^\w.:-]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'skill';

const commandAliases = (skill: SkillEntry) => {
  const folder = skill.path?.split(/[\\/]/).at(-2)?.toLowerCase();
  return [skillCommand(skill), skill.name.toLowerCase(), folder].filter(
    Boolean,
  );
};

export const unavailableReason = (skill: SkillEntry, catalog?: SkillCatalog) =>
  skill.invocation === 'blocked'
    ? skill.invocationReason || 'Unavailable for this connection'
    : skill.invocation === 'native' || skill.invocation === 'instructions'
      ? skill.path
        ? ''
        : 'Source file is unavailable'
      : catalog?.method !== 'native' || !catalog.invocationSupported
        ? 'Invocation unavailable'
        : skill.enabled !== true
          ? 'Not enabled in this connection'
          : skill.source === 'plugin'
            ? 'Plugin skill invocation is not supported'
            : skill.kind !== 'skill'
              ? 'Command invocation is not supported'
              : !skill.path
                ? 'Source file is unavailable'
                : skill.userInvocable === false
                  ? 'Manual invocation is disabled'
                  : '';

export const matchesSkillQuery = (skill: SkillEntry, query: string) =>
  [
    skillCommand(skill),
    skill.name,
    skill.description,
    skill.path,
    sourceLabels[skill.source],
    ...(skill.origins ?? []),
  ].some(value => value?.toLowerCase().includes(query));

export const typedCommandOf = (draft: string) => {
  const match = typedCommandPattern.exec(draft.trim());
  return match?.[1]
    ? { command: match[1].toLowerCase(), text: (match[2] ?? '').trim() }
    : null;
};

export type TypedSkillResolution =
  | { status: 'skill'; skill: SkillEntry; text: string }
  | { status: 'error'; message: string };

export const resolveTypedSkill = (
  catalog: SkillCatalog,
  command: string,
  text: string,
): TypedSkillResolution => {
  const matches = catalog.skills.filter(skill =>
    commandAliases(skill).includes(command),
  );
  const available = matches.filter(skill => !unavailableReason(skill, catalog));
  if (available.length === 1 && available[0])
    return { status: 'skill', skill: available[0], text };
  if (available.length > 1)
    return {
      status: 'error',
      message: `Several skills match /${command}. Choose one from the list.`,
    };
  if (matches[0])
    return {
      status: 'error',
      message: `/${command} cannot be used here: ${unavailableReason(matches[0], catalog)}.`,
    };
  return {
    status: 'error',
    message: `No available skill is named /${command}. Choose one from the list, or remove the leading slash to send plain text.`,
  };
};
