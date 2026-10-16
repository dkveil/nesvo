import { useState } from 'react';

/** Local UI preferences are separate from the authoritative host snapshot. */
export function useWorkspaceViewState() {
  const [connectOpen, setConnectOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<'all' | 'attention'>('all');
  // 'all' differs from null: null selects sessions outside every group.
  const [selectedGroup, setSelectedGroup] = useState<string | null>('all');
  const [sessionGroup, setSessionGroup] = useState<string | null>(null);

  function resetView() {
    setSelectedGroup('all');
    setSessionGroup(null);
    setQuery('');
    setFilter('all');
  }

  return {
    connectOpen,
    setConnectOpen,
    createOpen,
    setCreateOpen,
    query,
    setQuery,
    filter,
    setFilter,
    selectedGroup,
    setSelectedGroup,
    sessionGroup,
    setSessionGroup,
    resetView,
  };
}
