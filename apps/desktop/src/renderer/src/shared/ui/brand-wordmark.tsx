import type { ComponentProps } from 'react';
import { cn } from 'cn';

const LETTERS = [
  { x: 0, d: 'M0 64V0H40L64 24V64H44V32L32 20H20V64Z' },
  { x: 78, d: 'M0 0H44L60 16H20V24H50V40H20V48H60V64H0Z' },
  {
    x: 152,
    d: 'M16 0H64V16H20V24H48L64 40V48L48 64H0V48H44V40H16L0 24V16Z',
  },
  { x: 230, d: 'M0 0H20V32L32 44L44 32V0H64V40L40 64H24L0 40Z' },
  { x: 308, d: 'M0 0H40L64 24V64H24L0 40ZM20 20V32L32 44H44V32L32 20Z' },
] as const;

export const BrandWordmark = ({
  className,
  ...props
}: ComponentProps<'svg'>) => (
  <svg
    viewBox="0 0 372 64"
    role="img"
    aria-label="Nesvo"
    className={cn('h-3 w-auto shrink-0 text-brand-mark', className)}
    {...props}
  >
    <g fill="currentColor" fillRule="evenodd">
      {LETTERS.map(letter => (
        <path
          key={letter.x}
          transform={`translate(${letter.x} 0)`}
          d={letter.d}
        />
      ))}
    </g>
  </svg>
);
