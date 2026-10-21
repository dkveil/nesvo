import { Platform } from 'react-native';

import Constants, { ExecutionEnvironment } from 'expo-constants';
import * as SecureStore from 'expo-secure-store';

import { type NotificationTarget, parseNotificationTarget } from './target';

export {
  type InboxPushTarget,
  type NotificationTarget,
  parseInboxTarget,
  parseNotificationTarget,
  parseTarget,
  type PushTarget,
} from './target';
export type Registration = { hostId: string; token: string; kinds?: string[] };
const KEY = 'nesvo.push.v1';
export const pushAvailable =
  Platform.OS !== 'web' && Constants.executionEnvironment !== ExecutionEnvironment.StoreClient;
export async function readRegistration(): Promise<Registration | null> {
  if (!pushAvailable) return null;
  const raw = await SecureStore.getItemAsync(KEY);
  if (!raw) return null;
  const value: unknown = JSON.parse(raw);
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Record<string, unknown>;
  return typeof v.hostId === 'string' &&
    /^[a-f0-9]{32}$/.test(v.hostId) &&
    typeof v.token === 'string' &&
    /^(ExponentPushToken|ExpoPushToken)\[[A-Za-z0-9_-]{10,200}\]$/.test(v.token)
    ? {
        hostId: v.hostId,
        token: v.token,
        kinds: Array.isArray(v.kinds)
          ? v.kinds.filter((kind): kind is string => typeof kind === 'string')
          : undefined,
      }
    : null;
}
export async function saveRegistration(value: Registration | null) {
  if (!pushAvailable) return;
  if (value) await SecureStore.setItemAsync(KEY, JSON.stringify(value));
  else await SecureStore.deleteItemAsync(KEY);
}
export async function requestPushToken(): Promise<string> {
  if (!pushAvailable) throw new Error('Notifications need the native nesvo build.');
  const notifications = await import('expo-notifications');
  if (Platform.OS === 'android')
    await notifications.setNotificationChannelAsync('attention', {
      name: 'Sessions that need you',
      importance: notifications.AndroidImportance.DEFAULT,
    });
  let permission = await notifications.getPermissionsAsync();
  if (!permission.granted) permission = await notifications.requestPermissionsAsync();
  if (!permission.granted) throw new Error('Allow notifications in phone settings.');
  const projectId = Constants.easConfig?.projectId ?? Constants.expoConfig?.extra?.eas?.projectId;
  if (typeof projectId !== 'string')
    throw new Error('This build has no notification configuration.');
  return (await notifications.getExpoPushTokenAsync({ projectId })).data;
}
export async function observePush(
  onTarget: (target: NotificationTarget) => void,
): Promise<() => void> {
  if (!pushAvailable) return () => {};
  const notifications = await import('expo-notifications');
  notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldPlaySound: false,
      shouldSetBadge: false,
      shouldShowBanner: true,
      shouldShowList: true,
    }),
  });
  let last = '';
  const consume = (response: import('expo-notifications').NotificationResponse) => {
    const id = response.notification.request.identifier;
    if (id === last) return;
    const target = parseNotificationTarget(response.notification.request.content.data);
    if (target) {
      last = id;
      onTarget(target);
      void notifications.clearLastNotificationResponseAsync().catch(() => {});
    }
  };
  const initial = notifications.getLastNotificationResponse();
  if (initial) consume(initial);
  const subscription = notifications.addNotificationResponseReceivedListener(consume);
  return () => subscription.remove();
}
