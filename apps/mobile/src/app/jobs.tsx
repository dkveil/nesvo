import { router, useIsFocused } from 'expo-router';

import { JobsScreen } from '@features/browse-jobs';

const goBack = () => (router.canGoBack() ? router.back() : router.replace('/'));

export default function JobsRoute() {
  const active = useIsFocused();
  return <JobsScreen active={active} onBack={goBack} />;
}
