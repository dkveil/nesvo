import { SettingsRow } from '@/shared/ui/settings-section';
import { Switch } from '@/shared/ui/switch';

export function WorktreeDefaultRow({
  id,
  checked,
  onChange,
  className,
}: {
  id: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  className?: string;
}) {
  return (
    <SettingsRow
      className={className}
      title={<label htmlFor={id}>Start sessions in a worktree</label>}
      description="Applies when the folder is a Git repository."
    >
      <Switch id={id} checked={checked} onCheckedChange={onChange} />
    </SettingsRow>
  );
}
