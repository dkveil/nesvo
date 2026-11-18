'use client';

import { useId, useState, type ReactNode } from 'react';

export type QuietDisclosure = {
  key: string;
  label: string;
  content: ReactNode;
};

type QuietDisclosuresProps = {
  items: QuietDisclosure[];
  links?: ReactNode;
};

export const QuietDisclosures = ({ items, links }: QuietDisclosuresProps) => {
  const [openKey, setOpenKey] = useState<string | null>(null);
  const baseId = useId();
  const panelId = (key: string) => `${baseId}-${key}`;

  const handleToggle = (key: string) =>
    setOpenKey(current => (current === key ? null : key));

  return (
    <div className="quiet">
      <div className="quiet-row">
        {items.map(item => (
          <button
            key={item.key}
            type="button"
            className="quiet-toggle"
            aria-expanded={openKey === item.key}
            aria-controls={panelId(item.key)}
            onClick={() => handleToggle(item.key)}
          >
            {item.label}
          </button>
        ))}
        {links}
      </div>
      {items.map(item => (
        <section
          key={item.key}
          id={panelId(item.key)}
          className="quiet-panel"
          aria-label={item.label}
          hidden={openKey !== item.key}
        >
          {item.content}
        </section>
      ))}
    </div>
  );
};
