const effortLabels: Record<string, string> = {
  none: 'None',
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
  max: 'Max',
};

export function effortLabel(effort: string) {
  return (
    effortLabels[effort] ??
    `${effort.charAt(0).toUpperCase()}${effort.slice(1)}`
  );
}
