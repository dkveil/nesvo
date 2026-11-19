import { ExternalLink, RadioTower } from 'lucide-react';
import type { RunningApp } from '@nesvo/contracts';
import { Chip } from '@/shared/ui/chip';
import { Disclosure } from '@/shared/ui/disclosure';
import { Button } from '@/shared/ui/button';
import { ListRow } from '@/shared/ui/list-row';
import { Popover, PopoverContent, PopoverTrigger } from '@/shared/ui/popover';
import { Hint } from '@/shared/ui/tooltip';
import { runningAppsSummary } from './running-apps-summary';

type Props = {
  apps: readonly RunningApp[];
  local: boolean;
  owner: (sessionId: string) => string;
};

function PortRows({ apps, local, owner }: Props) {
  if (!apps.length) return null;
  const showOwner = new Set(apps.map(app => app.sessionId)).size > 1;
  return (
    <ul>
      {apps.map(app => {
        const host =
          app.address === '::' || app.address === '::1'
            ? '[::1]'
            : app.address === '0.0.0.0'
              ? '127.0.0.1'
              : app.address;
        const label = /^127\.(?!0\.0\.1$)/.test(host) ? host : 'localhost';
        const description = [
          showOwner ? owner(app.sessionId) : '',
          app.match === 'folder' ? 'Matched by folder' : '',
        ]
          .filter(Boolean)
          .join(' · ');
        return (
          <li key={app.pid + ':' + app.port}>
            <ListRow
              density={description ? 'two-line' : 'compact'}
              title={
                <span className="tabular-nums" title={label + ':' + app.port}>
                  {app.web ? 'Web app' : 'TCP'} · port {app.port}
                </span>
              }
              description={description || undefined}
              actionsPlacement="visible"
              actions={
                local &&
                app.web === true && (
                  <Button
                    variant="ghost"
                    aria-label={'Open ' + label + ':' + app.port}
                    size="xs"
                    onClick={() =>
                      void window.nesvo
                        .openExternal('http://' + host + ':' + app.port)
                        .catch(() => undefined)
                    }
                  >
                    Open
                    <ExternalLink />
                  </Button>
                )
              }
            />
          </li>
        );
      })}
    </ul>
  );
}

function PortLists({ apps, ...props }: Props) {
  const servers = apps.filter(app => app.web === true);
  const other = apps.filter(app => app.web !== true);
  return (
    <>
      <PortRows apps={servers} {...props} />
      {other.length > 0 && (
        <Disclosure
          title="Other ports"
          meta={other.length}
          contentClassName="pl-2"
        >
          <PortRows apps={other} {...props} />
        </Disclosure>
      )}
    </>
  );
}

export function RunningAppsSection(props: Props) {
  if (!props.apps.length) return null;
  return (
    <section aria-label="Servers" className="space-y-2">
      <h2 className="text-xs font-medium">Servers</h2>
      <PortLists {...props} />
    </section>
  );
}

export function RunningAppsChip(props: Props) {
  if (!props.apps.length) return null;
  const servers = props.apps.filter(app => app.web === true);
  const label = servers.length
    ? 'Servers on ports ' + servers.map(app => app.port).join(', ')
    : 'Other ports';
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
            <span>
              {servers.length
                ? `Servers ${runningAppsSummary(servers)}`
                : 'Other ports'}
            </span>
          </Chip>
        </PopoverTrigger>
      </Hint>
      <PopoverContent
        align="start"
        aria-label="Servers"
        surface="solid"
        size="md"
        padding="sm"
        scroll
      >
        <PortLists {...props} />
      </PopoverContent>
    </Popover>
  );
}
