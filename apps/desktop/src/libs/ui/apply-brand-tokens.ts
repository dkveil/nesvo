import tokens from '@nesvo/brand/tokens.json';

export const applyBrandTokens = (target: HTMLElement = document.documentElement) => {
  for (const [name, value] of Object.entries(tokens.colors)) {
    target.style.setProperty(`--brand-${name}`, value);
  }
};
