import { createContext, type PropsWithChildren, useContext } from 'react';

import { useInboxState } from './use-inbox-state';

type InboxValue = ReturnType<typeof useInboxState>;

const InboxContext = createContext<InboxValue | null>(null);

export const InboxProvider = ({ children }: PropsWithChildren) => {
  const value = useInboxState();
  return <InboxContext.Provider value={value}>{children}</InboxContext.Provider>;
};

export const useInbox = (): InboxValue => {
  const value = useContext(InboxContext);
  if (!value) throw new Error('InboxProvider is missing from the application shell.');
  return value;
};
