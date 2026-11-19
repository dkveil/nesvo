import { createContext } from 'react';
import type { ConfigurationOwnerFlowLink } from '@nesvo/contracts';

export type SettingsAuthorityReview = {
  hostId: string;
  review: ConfigurationOwnerFlowLink;
} & (
  | { kind: 'devices'; name: string }
  | { kind: 'computers'; name: string }
  | { kind: 'phone-access'; action: 'enable' | 'pair' }
);

export const AuthoritySettingsContext = createContext<
  ((review: SettingsAuthorityReview) => void) | undefined
>(undefined);

export function isChangedDeviceGrant(error: unknown) {
  return (
    error instanceof Error && error.message.includes('device grant changed')
  );
}
