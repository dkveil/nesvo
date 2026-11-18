import { FileCode2 } from 'lucide-react';
import { AttachmentToken } from '@/shared/ui/attachment-token';
import { Hint } from '@/shared/ui/tooltip';
import { commentFullLocation, commentLocation } from './location';
import type { PendingCodeComment } from './store';

export function CodeCommentToken({ item }: { item: PendingCodeComment }) {
  return (
    <Hint label={`${commentFullLocation(item.comment)} · ${item.comment.body}`}>
      <AttachmentToken
        kind="Code comment"
        name={commentLocation(item.comment)}
        icon={<FileCode2 />}
        className="font-mono"
      />
    </Hint>
  );
}
