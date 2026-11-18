import type { Provider, ProviderProfile } from '@nesvo/contracts';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/shared/ui/select';

const DEFAULT = 'default';
const INHERIT = 'inherit';

export function ProfileSelect({
  id,
  label = 'Provider account',
  profiles,
  provider,
  value,
  onChange,
  inherit,
  disabled,
  className,
}: {
  id?: string;
  label?: string;
  profiles: ProviderProfile[];
  provider: Provider | null;
  value: string | null | undefined;
  onChange: (id: string | null | undefined) => void;
  inherit?: string;
  disabled?: boolean;
  className?: string;
}) {
  const available = profiles.filter(profile => profile.provider === provider);
  const missing = value && !available.some(profile => profile.id === value);
  return (
    <Select
      value={value ?? (value === undefined && inherit ? INHERIT : DEFAULT)}
      onValueChange={next =>
        onChange(next === INHERIT ? undefined : next === DEFAULT ? null : next)
      }
      disabled={disabled || !provider}
    >
      <SelectTrigger id={id} aria-label={label} size="md" className={className}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent position="popper" className="max-h-72">
        {inherit && <SelectItem value={INHERIT}>{inherit}</SelectItem>}
        <SelectItem value={DEFAULT}>Default account</SelectItem>
        {available.map(profile => (
          <SelectItem key={profile.id} value={profile.id}>
            {profile.label}
          </SelectItem>
        ))}
        {missing && <SelectItem value={value}>Account unavailable</SelectItem>}
      </SelectContent>
    </Select>
  );
}
