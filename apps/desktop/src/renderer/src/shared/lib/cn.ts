import { createCn } from 'cn/config';

export const cn = createCn({
  extend: {
    theme: {
      text: ['micro', 'ui', 'title', 'display', 'display-lg'],
      radius: ['control', 'surface', 'overlay', 'composer'],
    },
    classGroups: {
      duration: [{ duration: ['fast', 'base', 'slow'] }],
    },
  },
});
