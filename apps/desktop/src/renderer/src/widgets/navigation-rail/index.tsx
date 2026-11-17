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
import { cn } from 'cn';
import { Button } from '@/shared/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/shared/ui/tooltip';

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

type RailButtonProps = ComponentProps<typeof Button> & {
  label: string;
  hint?: string;
  shortcut?: string;
  active?: boolean;
};

function RailButton({
  label,
  hint = label,
  shortcut,
  active = false,
  className,
  children,
  ...props
}: RailButtonProps) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={label}
          aria-current={active ? 'page' : undefined}
          className={cn(
            'relative size-8 text-sidebar-icon hover:bg-sidebar-row-hover hover:text-sidebar-foreground',
            'before:absolute before:top-1/2 before:-left-1.5 before:h-4 before:w-0.5 before:-translate-y-1/2 before:scale-y-0 before:rounded-full before:bg-foreground before:transition-transform before:duration-150 before:ease-out',
            '[&>svg]:transition-transform [&>svg]:duration-150 [&>svg]:ease-out hover:[&>svg]:scale-110',
            active &&
              'bg-sidebar-row-selected text-sidebar-foreground before:scale-y-100',
            className,
          )}
          {...props}
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="right" shortcut={shortcut}>
        {hint}
      </TooltipContent>
    </Tooltip>
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
    <>
      <nav
        aria-label="Primary"
        className="flex h-full w-(--rail-width) shrink-0 flex-col items-center border-r border-sidebar-border bg-sidebar pb-2"
      >
        <div className="drag-region flex h-(--shell-topbar-height) w-full shrink-0 items-center justify-center">
          <RailButton
            ref={sidebarToggleRef}
            label={sidebarOpen ? 'Collapse sidebar' : 'Expand sidebar'}
            shortcut="Ctrl B"
            aria-pressed={sidebarOpen}
            onClick={onToggleSidebar}
          >
            <PanelLeft className="size-4" />
          </RailButton>
        </div>
        <div className="flex flex-col items-center gap-1">
          {!sidebarOpen && (
            <RailButton label="New session" onClick={onCreate}>
              <SquarePen className="size-4" />
            </RailButton>
          )}
          <RailButton label="Inbox" active={inbox} onClick={onInbox}>
            <Inbox className="size-4" />
            {pendingActions > 0 && (
              <span
                aria-label={`${pendingActions} pending items`}
                className="absolute -top-0.5 -right-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-foreground px-1 text-2xs leading-none font-semibold text-background tabular-nums"
              >
                {pendingActions}
              </span>
            )}
          </RailButton>
          {automationsAvailable && onAutomations && (
            <RailButton
              label="Automations"
              active={automations}
              onClick={onAutomations}
            >
              <CalendarClock className="size-4" />
            </RailButton>
          )}
          <RailButton
            label="Workflows"
            active={workflows}
            onClick={onWorkflows}
          >
            <Workflow className="size-4" />
          </RailButton>
          {onPullRequests && (
            <RailButton
              label="Pull requests"
              active={pullRequests}
              onClick={onPullRequests}
            >
              <GitPullRequest className="size-4" />
            </RailButton>
          )}
          {onCosts && (
            <RailButton label="Costs" active={costs} onClick={onCosts}>
              <ChartNoAxesColumn className="size-4" />
            </RailButton>
          )}
        </div>
        <div className="min-h-0 flex-1" />
        <div className="flex flex-col items-center gap-1">
          {usage}
          <RailButton label="Settings" onClick={onSettings}>
            <Settings className="size-4" />
          </RailButton>
          <RailButton
            label="Computers"
            hint={`Computers · ${hostName}`}
            onClick={onComputers}
          >
            <Monitor className="size-4" />
          </RailButton>
        </div>
      </nav>
    </>
  );
}
