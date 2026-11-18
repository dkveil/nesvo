import { useRef } from 'react';
import { Paperclip } from 'lucide-react';
import { DisabledHint } from '@/shared/ui/disabled-hint';
import { IconButton } from '@/shared/ui/icon-button';
import type { AttachmentSupport } from './attachment-support';

type AttachButtonProps = {
  support: AttachmentSupport;
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
      <DisabledHint reason={support.enabled ? '' : support.reason}>
        <IconButton
          label="Attach files"
          size={24}
          tooltip={support.enabled}
          disabled={disabled || !support.enabled}
          onClick={() => input.current?.click()}
        >
          <Paperclip />
        </IconButton>
      </DisabledHint>
      <input
        ref={input}
        type="file"
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
