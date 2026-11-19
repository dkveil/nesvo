import type {
  ManagerImportCatalog,
  ManagerImportSource,
} from '@nesvo/contracts';

export const managerLabels: Record<ManagerImportSource, string> = {
  't3-code': 'T3 Code',
  'agent-deck': 'Agent Deck',
};

const quantity = (count: number, noun: string) =>
  `${count} ${noun}${count === 1 ? '' : 's'}`;

export function managerImportSummary(
  source: ManagerImportSource,
  catalog: ManagerImportCatalog,
  found = false,
) {
  const groups = quantity(
    catalog.groupCount,
    source === 't3-code' ? 'project' : 'group',
  );
  const sessions = quantity(catalog.sessionCount, 'session');
  const profiles = quantity(catalog.profileCount, 'profile');
  if (found)
    return `We found ${managerLabels[source]} with ${source === 'agent-deck' ? profiles + ', ' : ''}${groups} and ${sessions}`;
  return `${source === 'agent-deck' ? profiles + ', ' : ''}${groups} · ${sessions}`;
}
