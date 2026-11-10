import { X } from 'lucide-react';
import { Button } from '@/shared/ui/button';
import type { SelectedSkill } from './index';

type Props = {
  skill: SelectedSkill;
  onRemove: () => void;
};

export function SelectedSkillChip({ skill, onRemove }: Props) {
  return (
    <div className="mb-2 flex items-center gap-1">
      <span
        aria-label={`Selected skill: ${skill.name}`}
        title={[
          skill.description,
          `${skill.source} · ${skill.path}`,
          skill.origins?.join(', '),
          skill.delivery === 'instructions'
            ? 'Shared instructions · static snapshot for this message'
            : skill.delivery === 'native'
              ? 'Native skill'
              : '',
          skill.contentHash ? `SHA-256: ${skill.contentHash}` : '',
        ]
          .filter(Boolean)
          .join('\n')}
        className="max-w-[calc(100%-2rem)] truncate rounded-md border bg-secondary/60 px-2 py-1 text-xs"
      >
        {skill.name}
        {skill.delivery === 'instructions' && (
          <span className="ml-2 text-muted-foreground">
            Shared instructions
          </span>
        )}
      </span>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="size-6 text-muted-foreground"
        aria-label="Remove skill"
        onClick={onRemove}
      >
        <X className="size-3" />
      </Button>
    </div>
  );
}
