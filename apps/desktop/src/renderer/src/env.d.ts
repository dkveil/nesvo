import type { DesktopApi } from '@nesvo/contracts';

declare global {
  interface Window {
    nesvo: DesktopApi;
  }
}
