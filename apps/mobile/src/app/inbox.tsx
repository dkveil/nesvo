import { router } from 'expo-router';

import { InboxScreen } from '@features/attention-inbox';

const goBack = () => (router.canGoBack() ? router.back() : router.replace('/'));

export default function InboxRoute() {
  return <InboxScreen onBack={goBack} />;
}
