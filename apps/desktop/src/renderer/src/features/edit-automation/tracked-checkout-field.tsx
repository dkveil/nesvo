import type { TrackedRepository } from '@nesvo/contracts';
import { Field } from '@/shared/ui/field';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/shared/ui/select';

type TrackedCheckoutFieldProps = {
  repositories: TrackedRepository[];
  directory: string;
  disabled: boolean;
  onChange: (directory: string) => void;
};

export function TrackedCheckoutField({
  repositories,
  directory,
  disabled,
  onChange,
}: TrackedCheckoutFieldProps) {
  const checkouts = repositories.filter(
    (item): item is TrackedRepository & { directory: string } =>
      !!item.directory,
  );
  if (checkouts.length === 0) return null;
  const selected = checkouts.find(item => item.directory === directory.trim());
  return (
    <Field
      id="automation-tracked-repository"
      label="Tracked repository"
      hint="Fills in the folder with the repository’s local checkout."
    >
      <Select
        value={selected?.id ?? ''}
        disabled={disabled}
        onValueChange={id => {
          const choice = checkouts.find(item => item.id === id);
          if (choice) onChange(choice.directory);
        }}
      >
        <SelectTrigger
          id="automation-tracked-repository"
          size="md"
          className="w-full"
        >
          <SelectValue placeholder="Choose a tracked repository" />
        </SelectTrigger>
        <SelectContent position="popper">
          {checkouts.map(item => (
            <SelectItem key={item.id} value={item.id}>
              {item.repository}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </Field>
  );
}
