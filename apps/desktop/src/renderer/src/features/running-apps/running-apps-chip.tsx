import { ExternalLink, RadioTower } from 'lucide-react';
import type { RunningApp } from '@nesvo/contracts';
import { Chip } from '@/shared/ui/chip';
import { IconButton } from '@/shared/ui/icon-button';
import { ListRow } from '@/shared/ui/list-row';
import { Popover, PopoverContent, PopoverTrigger } from '@/shared/ui/popover';
import { Hint } from '@/shared/ui/tooltip';
import { runningAppsSummary } from './running-apps-summary';

type Props = {
  apps: readonly RunningApp[];
  computerName: string;
  local: boolean;
};

const matchLabels: Record<RunningApp['match'], string> = {
  process: 'Started by this session',
  folder: 'Running in this session’s folder',
};

export function RunningAppsChip({ apps, computerName, local }: Props) {
  if (apps.length === 0) return null;
  const ports = apps.map(app => app.port).join(', ');
  const label = `${apps.length === 1 ? 'Running app on port' : 'Running apps on ports'} ${ports}`;
  return (
    <Popover>
      <Hint label={label}>
        <PopoverTrigger asChild>
          <Chip
            size="sm"
            aria-label={label}
            data-running-apps=""
            icon={<RadioTower aria-hidden="true" />}
            className="font-mono tabular-nums"
          >
            <span>{runningAppsSummary(apps)}</span>
          </Chip>
        </PopoverTrigger>
      </Hint>
      <PopoverContent
        align="start"
        aria-label="Running apps"
        size="md"
        padding="sm"
        scroll
      >
        <p className="px-1.5 pb-1.5 text-xs text-muted-foreground">
          Listening ports on {computerName}. Nesvo only reads them.
        </p>
        <ul>
          {apps.map(app => (
            <li key={`${app.pid}:${app.port}`}>
              <ListRow
                density="two-line"
                title={
                  <span className="font-mono tabular-nums">
                    {app.address}:{app.port}
                  </span>
                }
                description={`${app.name || `Process ${app.pid}`} · ${matchLabels[app.match]}`}
                actionsPlacement="visible"
                actions={
                  local && (
                    <IconButton
                      label={`Open localhost:${app.port}`}
                      size={24}
                      onClick={() =>
                        void window.nesvo
                          .openExternal(`http://localhost:${app.port}`)
                          .catch(() => undefined)
                      }
                    >
                      <ExternalLink />
                    </IconButton>
                  )
                }
              />
            </li>
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  );
}
