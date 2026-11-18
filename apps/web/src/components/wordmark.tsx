const LETTERS = [
  { x: 18, path: 'M0 64V0H40L64 24V64H44V32L32 20H20V64Z' },
  { x: 96, path: 'M0 0H44L60 16H20V24H50V40H20V48H60V64H0Z' },
  {
    x: 170,
    path: 'M16 0H64V16H20V24H48L64 40V48L48 64H0V48H44V40H16L0 24V16Z',
  },
  { x: 248, path: 'M0 0H20V32L32 44L44 32V0H64V40L40 64H24L0 40Z' },
  { x: 326, path: 'M0 0H40L64 24V64H24L0 40ZM20 20V32L32 44H44V32L32 20Z' },
] as const;

type WordmarkProps = {
  className?: string;
};

export const Wordmark = ({ className }: WordmarkProps) => (
  <svg
    className={className}
    viewBox="18 18 372 64"
    role="img"
    aria-label="Nesvo"
    focusable="false"
  >
    <g fill="currentColor" fillRule="evenodd">
      {LETTERS.map(letter => (
        <path
          key={letter.x}
          className="letter"
          transform={`translate(${letter.x} 18)`}
          d={letter.path}
        />
      ))}
    </g>
  </svg>
);
