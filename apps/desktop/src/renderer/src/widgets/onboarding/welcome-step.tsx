import { Inbox, SlidersHorizontal, Workflow } from 'lucide-react';
import { BrandWordmark } from '@/shared/ui/brand-wordmark';

const points = [
  {
    icon: Inbox,
    title: 'Your Inbox, your decisions',
    detail: 'Choose which decisions reach you and at what stage.',
  },
  {
    icon: Workflow,
    title: 'Build systems for recurring work',
    detail: 'Set up autonomous workflows and daily routines.',
  },
  {
    icon: SlidersHorizontal,
    title: 'Set your level of control',
    detail: 'Run autonomously or approve each step.',
  },
];

export function WelcomeStep() {
  return (
    <div className="space-y-6">
      <header className="space-y-4 text-center">
        <BrandWordmark className="mx-auto h-8" />
        <h1 id="onboarding-title" className="text-base font-semibold">
          vibe with full control
        </h1>
        <p className="mx-auto max-w-lg text-ui leading-relaxed text-muted-foreground">
          Work with Claude Code and Codex side by side in one app, on this
          computer and your own servers.
        </p>
      </header>
      <ul className="mx-auto max-w-lg divide-y">
        {points.map(({ icon: Icon, title, detail }) => (
          <li key={title} className="flex items-start gap-2 px-3 py-3">
            <Icon
              aria-hidden="true"
              className="mt-0.5 size-4 shrink-0 text-muted-foreground"
            />
            <div>
              <p className="text-ui font-medium">{title}</p>
              <p className="text-xs leading-5 text-muted-foreground">
                {detail}
              </p>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
