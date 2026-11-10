import { useState } from 'react';
import { WrapText } from 'lucide-react';
import { cn } from 'cn';
import { Button } from '@/shared/ui/button';

type Segment = { kind: 'text' | 'code'; value: string; language: string };

const FENCE = /^```([^\n`]*)\n([\s\S]*?)^```[ \t]*$/gm;

const splitMessage = (body: string): Segment[] => {
  const segments: Segment[] = [];
  let cursor = 0;
  for (const match of body.matchAll(FENCE)) {
    const before = body.slice(cursor, match.index).replace(/\n+$/, '');
    if (before.trim())
      segments.push({ kind: 'text', value: before, language: '' });
    segments.push({
      kind: 'code',
      value: match[2]!.replace(/\n$/, ''),
      language: match[1]!.trim(),
    });
    cursor = match.index + match[0].length;
  }
  const rest = body.slice(cursor).replace(/^\n+/, '');
  if (rest.trim() || segments.length === 0)
    segments.push({ kind: 'text', value: rest, language: '' });
  return segments;
};

function CodeBlock({ code, language }: { code: string; language: string }) {
  const [wrap, setWrap] = useState(false);
  return (
    <figure
      aria-label={language ? `Code: ${language}` : 'Code'}
      className="overflow-hidden rounded-lg border bg-code-background"
    >
      <figcaption className="flex h-8 items-center justify-between gap-2 pr-1 pl-3 text-2xs text-muted-foreground">
        <span className="truncate font-mono">{language || 'text'}</span>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          className="text-muted-foreground hover:text-foreground aria-pressed:bg-highlight aria-pressed:text-foreground"
          aria-label="Wrap code lines"
          aria-pressed={wrap}
          onClick={() => setWrap(value => !value)}
        >
          <WrapText />
        </Button>
      </figcaption>
      <pre
        className={cn(
          'max-h-[28rem] overflow-auto px-3 pb-3 font-mono text-xs leading-5',
          wrap
            ? 'whitespace-pre-wrap [overflow-wrap:anywhere]'
            : 'whitespace-pre',
        )}
      >
        <code>{code}</code>
      </pre>
    </figure>
  );
}

export function MessageBody({
  body,
  className,
}: {
  body: string;
  className?: string;
}) {
  return (
    <div className={cn('space-y-3', className)}>
      {splitMessage(body).map((segment, index) =>
        segment.kind === 'code' ? (
          <CodeBlock
            key={index}
            code={segment.value}
            language={segment.language}
          />
        ) : (
          <p
            key={index}
            className="whitespace-pre-wrap [overflow-wrap:anywhere]"
          >
            {segment.value}
          </p>
        ),
      )}
    </div>
  );
}
