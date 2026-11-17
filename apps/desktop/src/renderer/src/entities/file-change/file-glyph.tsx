import type { ComponentProps } from 'react';
import {
  Braces,
  File,
  FileCode2,
  FileText,
  Hash,
  Image,
  Settings2,
  type LucideIcon,
} from 'lucide-react';
import { cn } from '@/shared/lib/cn';

type FileKind = { match: RegExp; icon: LucideIcon; tone: string };

const FILE_KINDS: FileKind[] = [
  {
    match: /\.(tsx?|jsx?|mjs|cjs|py|rb|go|rs|sh|ps1)$/i,
    icon: FileCode2,
    tone: 'text-file-code',
  },
  { match: /\.(json|jsonc|lock)$/i, icon: Braces, tone: 'text-file-data' },
  {
    match: /\.(md|mdx|txt)$|^LICENSE$/i,
    icon: FileText,
    tone: 'text-file-doc',
  },
  { match: /\.(css|scss|html)$/i, icon: Hash, tone: 'text-file-style' },
  {
    match: /\.(ya?ml|toml|ini|env)$|^\.[^.]+$/i,
    icon: Settings2,
    tone: 'text-file-config',
  },
  {
    match: /\.(png|jpe?g|gif|svg|ico|icns|webp)$/i,
    icon: Image,
    tone: 'text-file-media',
  },
];

type FileGlyphProps = ComponentProps<'svg'> & { name: string };

export function FileGlyph({ name, className, ...props }: FileGlyphProps) {
  const kind = FILE_KINDS.find(item => item.match.test(name));
  const Icon = kind?.icon ?? File;
  return (
    <Icon
      aria-hidden="true"
      className={cn(
        'size-3.5 shrink-0',
        kind?.tone ?? 'text-muted-foreground',
        className,
      )}
      {...props}
    />
  );
}
