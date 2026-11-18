import { SquarePen } from 'lucide-react';
import { Button } from '@/shared/ui/button';

type Props = {
  folder: string | null;
  onStartSession: () => void;
};

export function FinishStep({ folder, onStartSession }: Props) {
  return (
    <div className="space-y-4">
      <p className="text-ui">
        {folder ? (
          <>
            Your first session starts in{' '}
            <span className="font-mono [overflow-wrap:anywhere]">{folder}</span>
            . You can choose another folder in the session form.
          </>
        ) : (
          'Your first session starts in an isolated folder unless you choose one in the session form.'
        )}
      </p>
      <p className="text-xs leading-5 text-muted-foreground">
        Reopen this guide any time from the command palette or Settings › About.
      </p>
      <Button size="md" onClick={onStartSession}>
        <SquarePen />
        Start your first session
      </Button>
    </div>
  );
}
