import { StyleSheet, Text, View } from 'react-native';

import type { PushDevice, PushKind } from '@shared/api/host';
import { colors, mono } from '@shared/theme';
import { common, FreshnessBadge, Icon, Pill } from '@shared/ui';

import { usePushDevices } from './use-push-devices';

const DEVICE_KIND_LABELS = {
  decisionPending: 'Pending decisions',
  resultReady: 'Finished job results',
} as const satisfies Record<PushKind, string>;

const deviceKinds = (device: PushDevice) =>
  ['Session attention', ...device.kinds.map(kind => DEVICE_KIND_LABELS[kind])].join(' · ');

const isThisPhone = (device: PushDevice, token: string | null) =>
  !!token && token.replace(/\]$/, '').endsWith(device.device);

type PushDeviceListProps = { token: string | null };

export const PushDeviceList = ({ token }: PushDeviceListProps) => {
  const { supported, connected, devices, receivedAt, failed } = usePushDevices();
  if (!supported) return null;
  return (
    <View style={styles.list} accessibilityLabel="Registered phones">
      <View style={styles.heading}>
        <Text style={styles.title}>Registered phones</Text>
        <FreshnessBadge receivedAt={receivedAt} connected={connected} />
      </View>
      {devices === null ? (
        <Text style={common.body}>
          {failed
            ? 'The host did not list its phones. Reopen settings to try again.'
            : connected
              ? 'Loading registered phones…'
              : 'Connect to the host to see its registered phones.'}
        </Text>
      ) : devices.length === 0 ? (
        <Text style={common.body}>No phone receives notifications from this host yet.</Text>
      ) : (
        devices.map((device, index) => (
          <View
            key={`${device.device}-${index}`}
            style={styles.row}
            accessible
            accessibilityLabel={`Phone ending ${device.device}: ${deviceKinds(device)}`}
          >
            <Icon name="phone-portrait-outline" size={20} color={colors.text} />
            <View style={styles.text}>
              <Text style={styles.device}>Phone ending {device.device}</Text>
              <Text style={styles.kinds}>{deviceKinds(device)}</Text>
            </View>
            {isThisPhone(device, token) ? <Pill label="This phone" /> : null}
          </View>
        ))
      )}
      <Text style={styles.footnote}>
        Read-only. A phone leaves this list when it turns notifications off or Expo reports it as
        unregistered.
      </Text>
    </View>
  );
};

const styles = StyleSheet.create({
  list: { gap: 10 },
  heading: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  title: { color: colors.text, fontFamily: mono, fontSize: 14, fontWeight: '600' },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    padding: 12,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 8,
  },
  text: { flex: 1, minWidth: 0, gap: 2 },
  device: { color: colors.text, fontFamily: mono, fontSize: 13 },
  kinds: { color: colors.muted, fontSize: 12, lineHeight: 18 },
  footnote: { color: colors.faint, fontSize: 12, lineHeight: 18 },
});
