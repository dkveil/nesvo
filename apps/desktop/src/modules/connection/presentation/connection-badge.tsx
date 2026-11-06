import { useStore } from '@nanostores/react';

import { StatusBadge } from '../../../shared/components/status-badge';
import { $connectionState } from '../core/connection-store';
import { describeConnection } from '../core/describe-connection';

export const ConnectionBadge = () => {
  const state = useStore($connectionState);
  const { label, tone } = describeConnection(state);
  return (
    <StatusBadge tone={tone} title={state.message ?? undefined}>
      {label}
    </StatusBadge>
  );
};
