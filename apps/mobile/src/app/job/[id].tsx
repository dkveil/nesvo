import { router, useIsFocused, useLocalSearchParams } from 'expo-router';

import { JobDetailScreen } from '@features/browse-jobs';

const goBack = () => (router.canGoBack() ? router.back() : router.replace('/jobs'));

export default function JobRoute() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const active = useIsFocused();
  return <JobDetailScreen key={id} jobId={id ?? ''} active={active} onBack={goBack} />;
}
