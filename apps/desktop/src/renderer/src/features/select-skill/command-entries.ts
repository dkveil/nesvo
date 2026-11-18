import type { ClaudeCommand, SkillCatalog, SkillEntry } from '@nesvo/contracts';
import {
  commandAliases,
  commandScore,
  skillQueryScore,
  unavailableReason,
} from './skill-command';

export type MenuEntry =
  | { kind: 'skill'; id: string; skill: SkillEntry }
  | { kind: 'command'; id: string; command: ClaudeCommand };

const commandEntryId = (name: string) => `command:${name}`;

const nativeCommandScore = (command: ClaudeCommand, query: string) => {
  if (!query) return 0;
  const byName = commandScore(command.name.toLowerCase(), query);
  if (byName !== null) return byName;
  return command.description.toLowerCase().includes(query) ? 10 : null;
};

const availableAliases = (catalog: SkillCatalog) =>
  new Set(
    catalog.skills
      .filter(skill => !unavailableReason(skill, catalog))
      .flatMap(commandAliases),
  );

export const findNativeCommand = (
  commands: readonly ClaudeCommand[],
  name: string,
) => commands.find(command => command.name.toLowerCase() === name);

export const menuEntries = (
  catalog: SkillCatalog,
  commands: readonly ClaudeCommand[] | undefined,
  query: string,
): MenuEntry[] => {
  const native = new Set(
    commands?.map(command => command.name.toLowerCase()) ?? [],
  );
  const taken = availableAliases(catalog);
  const scored = [
    ...catalog.skills
      .filter(
        skill =>
          !commands ||
          (skill.kind !== 'command' &&
            (!unavailableReason(skill, catalog) ||
              !commandAliases(skill).some(alias => native.has(alias ?? '')))),
      )
      .map(skill => ({
        entry: { kind: 'skill', id: skill.id, skill } as MenuEntry,
        score: skillQueryScore(skill, query),
      })),
    ...(commands ?? [])
      .filter(command => !taken.has(command.name.toLowerCase()))
      .map(command => ({
        entry: {
          kind: 'command',
          id: commandEntryId(command.name),
          command,
        } as MenuEntry,
        score: nativeCommandScore(command, query),
      })),
  ];
  return scored
    .map((item, index) => ({ ...item, index }))
    .filter(
      (item): item is { entry: MenuEntry; score: number; index: number } =>
        item.score !== null,
    )
    .sort((left, right) => left.score - right.score || left.index - right.index)
    .map(item => item.entry);
};
