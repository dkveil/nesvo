import type { ComponentProps, ReactNode, RefObject } from 'react';
import {
  ChartNoAxesColumn,
  CalendarClock,
  GitPullRequest,
  Inbox,
  Monitor,
  PanelLeft,
  Settings,
  SquarePen,
  Workflow,
} from 'lucide-react';
import { cn } from '@/shared/lib/cn';
import { shortcutKeys } from '@/shared/lib/keyboard-shortcuts';
import { CountBadge } from '@/shared/ui/badge';
import { IconButton } from '@/shared/ui/icon-button';
import { Hint } from '@/shared/ui/tooltip';

type Props = {
  sidebarOpen: boolean;
  onToggleSidebar: () => void;
  sidebarToggleRef?: RefObject<HTMLButtonElement | null>;
  pendingActions: number;
  inbox: boolean;
  workflows: boolean;
  automations: boolean;
  automationsAvailable: boolean;
  hostName: string;
  onCreate: () => void;
  onInbox: () => void;
  onWorkflows: () => void;
  onAutomations?: () => void;
  pullRequests?: boolean;
  onPullRequests?: () => void;
  costs?: boolean;
  onCosts?: () => void;
  onSettings: () => void;
  onComputers: () => void;
  usage?: ReactNode;
};

type RailButtonProps = Omit<
  ComponentProps<typeof IconButton>,
  'size' | 'tone' | 'current' | 'marker' | 'tooltipSide'
> & { active?: boolean };

function RailButton({ active = false, ...props }: RailButtonProps) {
  return (
    <IconButton
      size={32}
      tone="sidebar"
      tooltipSide="right"
      current={active}
      marker
      {...props}
    />
  );
}

export function NavigationRail({
  sidebarOpen,
  onToggleSidebar,
  sidebarToggleRef,
  pendingActions,
  inbox,
  workflows,
  automations,
  automationsAvailable,
  hostName,
  onCreate,
  onInbox,
  onWorkflows,
  onAutomations,
  pullRequests = false,
  onPullRequests,
  costs = false,
  onCosts,
  onSettings,
  onComputers,
  usage,
}: Props) {
  return (
    <nav
      aria-label="Primary"
      className="flex h-full w-(--rail-width) shrink-0 flex-col items-center border-r border-sidebar-border bg-sidebar pb-2"
    >
      <div className="drag-region flex h-(--shell-topbar-height) w-full shrink-0 items-center justify-center">
        <RailButton
          ref={sidebarToggleRef}
          className="relative z-20 left-(--titlebar-inset-left)"
          label={sidebarOpen ? 'Collapse sidebar' : 'Expand sidebar'}
          shortcut={shortcutKeys('toggleSidebar')}
          aria-pressed={sidebarOpen}
          onClick={onToggleSidebar}
        >
          <PanelLeft />
        </RailButton>
      </div>
      <div className="flex flex-col items-center gap-1">
        <div
          inert={sidebarOpen}
          aria-hidden={sidebarOpen}
          className={cn(
            'grid transition-[grid-template-rows,margin,opacity] duration-slow ease-out',
            sidebarOpen ? '-mb-1 grid-rows-[0fr] opacity-0' : 'grid-rows-[1fr]',
          )}
        >
          <div className="min-h-0 overflow-hidden">
            <RailButton
              label="New session"
              shortcut={shortcutKeys('newSession')}
              onClick={onCreate}
            >
              <SquarePen />
            </RailButton>
          </div>
        </div>
        <RailButton label="Inbox" active={inbox} onClick={onInbox}>
          <Inbox />
          {pendingActions > 0 && (
            <CountBadge
              count={pendingActions}
              aria-label={`${pendingActions} pending items`}
              className="absolute -top-0.5 -right-0.5"
            />
          )}
        </RailButton>
        {automationsAvailable && onAutomations && (
          <RailButton
            label="Automations"
            active={automations}
            onClick={onAutomations}
          >
            <CalendarClock />
          </RailButton>
        )}
        <RailButton label="Workflows" active={workflows} onClick={onWorkflows}>
          <Workflow />
        </RailButton>
        {onPullRequests && (
          <RailButton
            label="Pull requests"
            active={pullRequests}
            onClick={onPullRequests}
          >
            <GitPullRequest />
          </RailButton>
        )}
        {onCosts && (
          <RailButton label="Costs" active={costs} onClick={onCosts}>
            <ChartNoAxesColumn />
          </RailButton>
        )}
      </div>
      <div className="min-h-0 flex-1" />
      <div className="flex flex-col items-center gap-1">
        {usage}
        <RailButton
          label="Settings"
          shortcut={shortcutKeys('settings')}
          onClick={onSettings}
        >
          <Settings />
        </RailButton>
        <Hint label={`Computers · ${hostName}`} side="right">
          <RailButton label="Computers" tooltip={false} onClick={onComputers}>
            <Monitor />
          </RailButton>
        </Hint>
      </div>
    </nav>
  );
}
