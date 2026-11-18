import { useEffect, useRef, useState } from 'react';
import { StatusDot } from '@/shared/ui/status-dot';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/shared/ui/tooltip';
import { indicatorDots, type SessionIndicator } from './session-indicator';

export function SessionIndicatorDot({
  indicator,
}: {
  indicator: SessionIndicator;
}) {
  const dot = useRef<HTMLSpanElement>(null);
  const [hovered, setHovered] = useState(false);
  const [rowFocused, setRowFocused] = useState(false);
  useEffect(() => {
    const row = dot.current?.closest('button');
    if (!row) return;
    const show = () => setRowFocused(row.matches(':focus-visible'));
    const hide = () => setRowFocused(false);
    row.addEventListener('focus', show);
    row.addEventListener('blur', hide);
    return () => {
      row.removeEventListener('focus', show);
      row.removeEventListener('blur', hide);
    };
  }, []);
  const { tone, variant } = indicatorDots[indicator.state];
  return (
    <Tooltip open={hovered || rowFocused} onOpenChange={setHovered}>
      <TooltipTrigger asChild>
        <StatusDot
          ref={dot}
          size="md"
          tone={tone}
          variant={variant}
          data-state-kind={indicator.state}
        />
      </TooltipTrigger>
      <TooltipContent side="top" align="start">
        {indicator.label}
      </TooltipContent>
    </Tooltip>
  );
}
