import {
  app,
  Menu,
  nativeImage,
  Tray,
  type BrowserWindow,
  type MenuItemConstructorOptions,
  type NativeImage,
} from 'electron';
import type { AttentionSession, DesktopAttention } from '@nesvo/contracts';
import { badgeBitmap, paintBadge } from './attention-badge';

const OVERLAY_SIZE_PX = 32;
const OVERLAY_SCALE = 2;
const TRAY_BADGE_RATIO = 0.6;
const MENU_TITLE_LENGTH = 60;

type Options = {
  iconPath: string;
  window: () => BrowserWindow | null;
  show: () => void;
  openSession: (target: AttentionSession) => void;
  quit: () => void;
  platform?: NodeJS.Platform;
};

export const attentionLabel = (count: number) =>
  count === 0
    ? 'Nothing needs you'
    : `${count} session${count === 1 ? ' needs' : 's need'} you`;

const menuTitle = (title: string) => {
  const trimmed = title.trim() || 'Untitled session';
  const short =
    trimmed.length > MENU_TITLE_LENGTH
      ? `${trimmed.slice(0, MENU_TITLE_LENGTH - 1)}…`
      : trimmed;
  return short.replaceAll('&', '&&');
};

export class AttentionIndicators {
  private tray: Tray | null = null;
  private attention: DesktopAttention = { count: 0, sessions: [] };
  private readonly platform: NodeJS.Platform;
  private readonly icon: NativeImage;

  constructor(private readonly options: Options) {
    this.platform = options.platform ?? process.platform;
    this.icon = nativeImage.createFromPath(options.iconPath);
  }

  start(): void {
    if (this.platform !== 'darwin' && !this.tray) {
      this.tray = new Tray(this.icon);
      this.tray.on('click', () => this.options.show());
    }
    this.render();
  }

  update(attention: DesktopAttention): void {
    this.attention = attention;
    this.render();
  }

  refreshWindow(): void {
    this.renderOverlay();
  }

  destroy(): void {
    this.tray?.destroy();
    this.tray = null;
  }

  private render(): void {
    const { count } = this.attention;
    const label = attentionLabel(count);
    if (this.tray) {
      this.tray.setToolTip(`Nesvo · ${label}`);
      this.tray.setImage(this.trayImage(count));
      this.tray.setContextMenu(Menu.buildFromTemplate(this.menu(true)));
    }
    if (this.platform === 'darwin') {
      app.dock?.setBadge(count ? String(count) : '');
      app.dock?.setMenu(Menu.buildFromTemplate(this.menu(false)));
    } else if (this.platform === 'linux') app.setBadgeCount(count);
    this.renderOverlay();
  }

  private renderOverlay(): void {
    if (this.platform !== 'win32') return;
    const window = this.options.window();
    if (!window || window.isDestroyed()) return;
    const { count } = this.attention;
    window.setOverlayIcon(
      count
        ? nativeImage.createFromBitmap(badgeBitmap(count, OVERLAY_SIZE_PX), {
            width: OVERLAY_SIZE_PX,
            height: OVERLAY_SIZE_PX,
            scaleFactor: OVERLAY_SCALE,
          })
        : null,
      attentionLabel(count),
    );
  }

  private trayImage(count: number): NativeImage {
    if (!count || this.icon.isEmpty()) return this.icon;
    const size = this.icon.getSize();
    const bitmap = Buffer.from(this.icon.toBitmap());
    const badge = Math.round(
      Math.min(size.width, size.height) * TRAY_BADGE_RATIO,
    );
    paintBadge(bitmap, size.width, count, badge, size.width - badge, 0);
    return nativeImage.createFromBitmap(bitmap, size);
  }

  private menu(standalone: boolean): MenuItemConstructorOptions[] {
    const { count, sessions } = this.attention;
    const entries: MenuItemConstructorOptions[] = sessions.length
      ? [
          { label: attentionLabel(count), enabled: false },
          ...sessions.map(session => ({
            label: menuTitle(session.title),
            click: () => this.options.openSession(session),
          })),
        ]
      : [{ label: attentionLabel(count), enabled: false }];
    if (!standalone) return entries;
    return [
      { label: 'Open Nesvo', click: () => this.options.show() },
      { type: 'separator' },
      ...entries,
      { type: 'separator' },
      { label: 'Quit Nesvo', click: () => this.options.quit() },
    ];
  }
}
