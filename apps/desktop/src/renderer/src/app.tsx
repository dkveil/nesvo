import { Workspace } from '@/pages/workspace';
import { TooltipProvider } from '@/shared/ui/tooltip';

export function App() {
  return (
    <TooltipProvider>
      <Workspace />
    </TooltipProvider>
  );
}
