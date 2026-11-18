import type { ReactNode } from 'react';
import { cn } from '@/shared/lib/cn';

type Props = {
  step: string;
  heading?: { title: string; description: string };
  children: ReactNode;
};

export function OnboardingStepLayout({ step, heading, children }: Props) {
  return (
    <div className="flex min-h-0 flex-1 overflow-y-auto">
      <section
        id="onboarding-step"
        aria-labelledby="onboarding-title"
        tabIndex={-1}
        data-onboarding-step={step}
        className={cn(
          'mx-auto w-full max-w-3xl space-y-4 px-10 outline-none',
          heading ? 'self-start pt-9 pb-5' : 'my-auto py-5',
        )}
      >
        {heading && (
          <header className="space-y-1.5">
            <h1
              id="onboarding-title"
              className="text-display-lg font-semibold tracking-tight"
            >
              {heading.title}
            </h1>
            <p className="text-sm text-muted-foreground">
              {heading.description}
            </p>
          </header>
        )}
        {children}
      </section>
    </div>
  );
}
