const isApple = () => /mac|iphone|ipad/i.test(navigator.platform);

export const shortcutLabel = (key: string) =>
  isApple() ? `⌘${key}` : `Ctrl+${key}`;
