import type { ComponentProps } from 'react';
import {
  File,
  CodeXml,
  ListTree,
  Palette,
  FileArchive,
  FileAudio,
  FileBraces,
  FileCode,
  FileImage,
  FileSpreadsheet,
  FileTerminal,
  FileText,
  FileVideo,
} from 'lucide-react';
import { cn } from '@/shared/lib/cn';
import { fileCategory, fileExtension } from '@/shared/lib/file-category';

type FileTypeIconProps = Omit<ComponentProps<'svg'>, 'name'> & {
  name: string;
};

export function FileTypeIcon({ name, className, ...props }: FileTypeIconProps) {
  const iconProps = {
    'aria-hidden': true,
    className: cn('shrink-0 text-muted-foreground', className),
    ...props,
  };
  switch (fileExtension(name)) {
    case 'ts':
    case 'tsx':
    case 'js':
    case 'jsx':
      return <CodeXml {...iconProps} />;
    case 'css':
      return <Palette {...iconProps} />;
    case 'yaml':
    case 'yml':
      return <ListTree {...iconProps} />;
  }
  switch (fileCategory(name)) {
    case 'image':
      return <FileImage {...iconProps} />;
    case 'document':
      return <FileText {...iconProps} />;
    case 'spreadsheet':
      return <FileSpreadsheet {...iconProps} />;
    case 'data':
      return <FileBraces {...iconProps} />;
    case 'archive':
      return <FileArchive {...iconProps} />;
    case 'audio':
      return <FileAudio {...iconProps} />;
    case 'video':
      return <FileVideo {...iconProps} />;
    case 'program':
      return <FileTerminal {...iconProps} />;
    case 'code':
      return <FileCode {...iconProps} />;
    default:
      return <File {...iconProps} />;
  }
}

export type { FileTypeIconProps };
