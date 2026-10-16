import { createContext, type PropsWithChildren, useContext } from 'react';

import { useWorkspaceState } from './workspace-state';
import type { WorkspaceNavigation } from './workspace-types';

const WorkspaceContext = createContext<ReturnType<typeof useWorkspaceState> | null>(null);

/** The root layout owns this provider so route changes keep the host connection alive. */
export function WorkspaceProvider({
  children,
  navigation,
}: PropsWithChildren<{ navigation: WorkspaceNavigation }>) {
  const value = useWorkspaceState(navigation);
  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>;
}

export function useWorkspace() {
  const value = useContext(WorkspaceContext);
  if (!value) throw new Error('WorkspaceProvider is missing from the root layout.');
  return value;
}
