import { useRef } from 'react';
import { ImagePlus } from 'lucide-react';
import { attachmentMediaTypes } from '@nesvo/contracts';
import { IconButton } from '@/shared/ui/icon-button';
import type { ImageSupport } from './image-support';

type AttachButtonProps = {
  support: ImageSupport;
  disabled?: boolean;
  onFiles: (files: File[]) => void;
};

export function AttachButton({
  support,
  disabled,
  onFiles,
}: AttachButtonProps) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <IconButton
        label={
          support.enabled
            ? 'Attach images'
            : `Images unavailable. ${support.reason}`
        }
        size={24}
        disabled={disabled || !support.enabled}
        onClick={() => input.current?.click()}
      >
        <ImagePlus />
      </IconButton>
      <input
        ref={input}
        type="file"
        accept={attachmentMediaTypes.join(',')}
        multiple
        hidden
        tabIndex={-1}
        aria-hidden="true"
        onChange={event => {
          const files = [...(event.target.files ?? [])];
          event.target.value = '';
          if (files.length) onFiles(files);
        }}
      />
    </>
  );
}
