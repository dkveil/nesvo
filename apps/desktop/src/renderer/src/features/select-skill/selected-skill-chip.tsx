import { BookOpen, X } from 'lucide-react';
import { Chip } from '@/shared/ui/chip';
import { IconButton } from '@/shared/ui/icon-button';
import type { SelectedSkill } from './index';

type Props = {
  skill: SelectedSkill;
  onRemove: () => void;
};

export function SelectedSkillChip({ skill, onRemove }: Props) {
  return (
    <div className="mb-2 flex min-w-0 items-center gap-0.5">
      <Chip
        interactive={false}
        size="sm"
        icon={<BookOpen aria-hidden="true" />}
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
        className="bg-highlight text-foreground"
      >
        <span>{skill.name}</span>
        {skill.delivery === 'instructions' && (
          <span className="text-muted-foreground">Shared instructions</span>
        )}
      </Chip>
      <IconButton label="Remove skill" size={24} onClick={onRemove}>
        <X />
      </IconButton>
    </div>
  );
}
