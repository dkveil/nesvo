import { useEffect, useState } from 'react';
import { Moon, Sun } from 'lucide-react';
import { Button } from '@/shared/ui/button';
import { SegmentedControl } from '@/shared/ui/segmented-control';
import { ActionsSection } from './actions';
import { DomainSection } from './domain';
import { FeedbackSection } from './feedback';
import { FoundationsSection } from './foundations';
import { InputsSection } from './inputs';
import { NavigationSection } from './navigation';
import { OverlaysSection } from './overlays';
import { SurfacesSection } from './surfaces';

type Scheme = 'dark' | 'light';

const SECTIONS = [
  ['foundations', 'Foundations'],
  ['actions', 'Actions'],
  ['inputs', 'Inputs'],
  ['navigation', 'Lists'],
  ['overlays', 'Overlays'],
  ['feedback', 'Feedback'],
  ['surfaces', 'Surfaces'],
  ['domain', 'Domain'],
] as const;

const SECTION_SCROLL_OFFSET_PX = 16;

const scrollParent = (element: HTMLElement) => {
  for (
    let parent = element.parentElement;
    parent;
    parent = parent.parentElement
  )
    if (/(auto|scroll)/.test(getComputedStyle(parent).overflowY)) return parent;
  return null;
};

const scrollToSection = (id: string) => {
  const target = document.getElementById(`catalog-${id}`);
  const scroller = target && scrollParent(target);
  if (!target || !scroller) return;
  scroller.scrollTop +=
    target.getBoundingClientRect().top -
    scroller.getBoundingClientRect().top -
    SECTION_SCROLL_OFFSET_PX;
};

const appliedScheme = (): Scheme =>
  document.documentElement.classList.contains('dark') ? 'dark' : 'light';

function usePreviewScheme() {
  const [initial] = useState(appliedScheme);
  const [scheme, setScheme] = useState<Scheme>(initial);
  useEffect(() => {
    document.documentElement.classList.toggle('dark', scheme === 'dark');
  }, [scheme]);
  useEffect(
    () => () => {
      document.documentElement.classList.toggle('dark', initial === 'dark');
    },
    [initial],
  );
  return [scheme, setScheme] as const;
}

export default function ComponentCatalog() {
  const [scheme, setScheme] = usePreviewScheme();
  return (
    <div className="space-y-10" data-testid="component-catalog">
      <header className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="space-y-0.5">
            <h1 className="text-title font-semibold tracking-tight">
              Components
            </h1>
            <p className="text-xs leading-5 text-muted-foreground">
              Development catalog of shared/ui. See docs/design-system.md for
              rules. Sample copy only.
            </p>
          </div>
          <SegmentedControl
            label="Preview appearance"
            size="md"
            value={scheme}
            onChange={setScheme}
            options={[
              { value: 'dark', label: 'Dark', icon: <Moon /> },
              { value: 'light', label: 'Light', icon: <Sun /> },
            ]}
          />
        </div>
        <nav
          aria-label="Catalog sections"
          className="flex flex-wrap gap-1 border-b pb-3"
        >
          {SECTIONS.map(([id, label]) => (
            <Button
              key={id}
              variant="ghost"
              size="xs"
              className="text-muted-foreground"
              onClick={() => scrollToSection(id)}
            >
              {label}
            </Button>
          ))}
        </nav>
      </header>
      <FoundationsSection />
      <ActionsSection />
      <InputsSection />
      <NavigationSection />
      <OverlaysSection />
      <FeedbackSection />
      <SurfacesSection />
      <DomainSection />
    </div>
  );
}
