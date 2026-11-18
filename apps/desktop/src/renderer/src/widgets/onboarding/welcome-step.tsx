import { Inbox, Monitor, Workflow } from 'lucide-react';

const lines = [
  {
    icon: Monitor,
    text: 'Run sessions with Claude Code and Codex on this computer or your own servers.',
  },
  {
    icon: Inbox,
    text: 'Review results, approvals and worker proposals in one Inbox.',
  },
  {
    icon: Workflow,
    text: 'Check work with workflows and repeat it with automations.',
  },
];

export function WelcomeStep() {
  return (
    <ul className="space-y-3" aria-label="What Nesvo does">
      {lines.map(({ icon: Icon, text }) => (
        <li key={text} className="flex items-start gap-3 text-ui">
          <Icon
            aria-hidden="true"
            className="mt-0.5 size-4 shrink-0 text-muted-foreground"
          />
          <span>{text}</span>
        </li>
      ))}
    </ul>
  );
}
