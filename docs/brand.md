# Brand

Nesvo uses a geometric wordmark built from five individually drawn vector letters. It does not depend on a font, so no font file or font licence is involved.

## Sources

- `brand/nesvo-wordmark.svg`: the full wordmark, single colour through `currentColor`.
- `brand/nesvo-mark.svg`: the `n` mark, used alone wherever the brand appears at icon size.

The brand defines two colours, black `#000000` and white `#ffffff`. The desktop renderer exposes them as `--brand-black`, `--brand-white` and the theme-aware `--brand-mark` (black in light mode, white in dark mode).

## Usage

- The full wordmark belongs in headers and brand material: the desktop sidebar header and the mobile home screen header.
- Small icons use the `n` mark only: window, taskbar, favicon, packaged desktop icons and mobile launcher icons.
- Icons place the white mark on a black tile. Desktop tiles keep a faint light edge so they stay visible on dark taskbars and docks.

## Generated files

Run `bun run brand:assets` after changing a source SVG. The script rasterizes the sources through the pinned Electron runtime and writes:

| File                                            | Purpose                                          |
| ----------------------------------------------- | ------------------------------------------------ |
| `apps/desktop/build/icon.ico`                   | Windows package icon, 16 to 256 px               |
| `apps/desktop/build/icon.icns`                  | macOS package icon, 16 to 1024 px                |
| `apps/desktop/build/icons/*.png`                | Linux package icons, 16 to 1024 px               |
| `apps/desktop/src/renderer/public/app-icon.png` | Window and taskbar icon                          |
| `apps/desktop/src/renderer/public/favicon.svg`  | Renderer favicon                                 |
| `apps/mobile-client/assets/icon.png`            | Mobile launcher icon, 1024 px, full bleed        |
| `apps/mobile-client/assets/adaptive-icon.png`   | Android adaptive foreground and monochrome layer |
| `apps/mobile-client/assets/wordmark.png`        | Mobile header wordmark at 3x                     |

The output is deterministic: running the script twice produces identical files. Commit the regenerated files together with the source change.

## Mobile splash

The mobile client does not configure a native splash image. Expo SDK 58 configures it through the `expo-splash-screen` config plugin, which is not a dependency yet. Until it is added, Android 12 and later show the adaptive launcher icon on the system splash.
