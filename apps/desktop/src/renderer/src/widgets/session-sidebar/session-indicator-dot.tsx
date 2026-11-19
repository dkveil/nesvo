import { useEffect, useRef, useState } from 'react';
import { StatusDot } from '@/shared/ui/status-dot';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/shared/ui/tooltip';
import { indicatorDots, type SessionIndicator } from './session-indicator';

const ROW_HOVER_DELAY_MS = 600;

export function SessionIndicatorDot({
  indicator,
  lifecycle = [],
}: {
  indicator: SessionIndicator;
  lifecycle?: string[];
}) {
  const dot = useRef<HTMLSpanElement>(null);
  const [hovered, setHovered] = useState(false);
  const [rowHovered, setRowHovered] = useState(false);
  const [rowFocused, setRowFocused] = useState(false);
  useEffect(() => {
    const row = dot.current?.closest('button');
    if (!row) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const show = () => setRowFocused(row.matches(':focus-visible'));
    const hide = () => setRowFocused(false);
    const enter = () => {
      clearTimeout(timer);
      timer = setTimeout(() => setRowHovered(true), ROW_HOVER_DELAY_MS);
    };
    const leave = () => {
      clearTimeout(timer);
      setRowHovered(false);
    };
    row.addEventListener('focus', show);
    row.addEventListener('blur', hide);
    row.addEventListener('pointerenter', enter);
    row.addEventListener('pointerleave', leave);
    row.addEventListener('pointerdown', leave);
    return () => {
      clearTimeout(timer);
      row.removeEventListener('focus', show);
      row.removeEventListener('blur', hide);
      row.removeEventListener('pointerenter', enter);
      row.removeEventListener('pointerleave', leave);
      row.removeEventListener('pointerdown', leave);
    };
  }, []);
  const { tone, variant } = indicatorDots[indicator.state];
  return (
    <Tooltip
      open={hovered || rowHovered || rowFocused}
      onOpenChange={setHovered}
    >
      <TooltipTrigger asChild>
        <StatusDot
          ref={dot}
          size="md"
          tone={tone}
          variant={variant}
          data-state-kind={indicator.state}
        />
      </TooltipTrigger>
      {lifecycle.length > 0 ? (
        <TooltipContent
          side="top"
          align="start"
          variant="panel"
          data-session-lifecycle=""
          className="pointer-events-none space-y-0.5 select-none"
        >
          <p className="font-medium">{indicator.label}</p>
          {lifecycle.map(line => (
            <p key={line} className="text-muted-foreground tabular-nums">
              {line}
            </p>
          ))}
        </TooltipContent>
      ) : (
        <TooltipContent side="top" align="start">
          {indicator.label}
        </TooltipContent>
      )}
    </Tooltip>
  );
}
