import { clsx, type ClassValue } from 'clsx';
import { extendTailwindMerge } from 'tailwind-merge';

const merge = extendTailwindMerge({
  extend: {
    theme: {
      text: [
        'micro',
        '2xs',
        'xs',
        'ui',
        'sm',
        'title',
        'display',
        'display-lg',
      ],
      radius: ['control', 'surface', 'overlay', 'composer'],
    },
    classGroups: {
      duration: [{ duration: ['fast', 'base', 'slow'] }],
    },
  },
});

export function cn(...inputs: ClassValue[]): string {
  return merge(clsx(inputs));
}
