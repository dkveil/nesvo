import { router, useIsFocused, useLocalSearchParams } from 'expo-router';

import { DecisionsScreen } from '@features/answer-decision';

const goBack = () => (router.canGoBack() ? router.back() : router.replace('/'));

export default function DecisionsRoute() {
  const { focus } = useLocalSearchParams<{ focus?: string }>();
  const active = useIsFocused();
  return <DecisionsScreen active={active} focusId={focus} onBack={goBack} />;
}
