# nesvo branding and compatibility

The project owner chose **nesvo** on October 16, 2026.

- Product and app display name: **nesvo**.
- GitHub repository: [dkveil/nesvo](https://github.com/dkveil/nesvo).
- npm workspace names: `@nesvo/mobile` and `@nesvo/brand`; `nesvo` is the private root tooling package.
- Native terminal client: `nesvo`; host: `nesvo-host`.
- The mobile UI currently uses Polish labels; repository documentation and code comments use English. A navigation label such as “Sesje” means “Sessions” and is not a separate product name.

The rename preserves compatibility identifiers deliberately:

- The EAS project ID, owner and slug retain their current values. Renaming the product does not create a new cloud project.
- Existing native bundle/application IDs and the URL scheme remain unchanged in this iteration. Changing them is an installation/deep-link migration, not a cosmetic rename.
- SecureStore keys, default legacy host data directories and existing host environment variables remain readable so users do not lose pairing or configuration.
- Pairing and encrypted transport formats do not change because of the product name.

Future identifier migrations must read existing data and preserve documented upgrade behavior. Do not replace legacy strings globally without checking their role.

## Ultraviolet

The approved mark and visual tokens live in [`packages/brand`](../packages/brand/README.md). Only the lowercase **nesvo** variant is shipped; the `.dev` variant is not used.

The canonical palette uses `#17171A` for the background, `#1E1E22` for panels and prompts, `#A34DFF` for the accent, `#EAE8EE` for text, `#ADACB5` for secondary text and `#35353D` for borders. Success, warning and error colors remain separate from selection and focus. Mobile and terminal adapters consume the same JSON tokens. The embedded xterm renderer includes these tokens in its offline bundle.

The SVG paths are the approved geometry. The terminal glyph grid matches every filled pixel in those paths. The first letter is the robot; neither it nor `esvo` is replaced with text from a font. A blink fills the entire five-pixel visor with violet. Only the pupil and detached pixel move, using a shared six-second stepped timeline.

Mobile renders the paths with `react-native-svg`; animation stops when inactive, offscreen, in the background, or when reduced motion is enabled. The terminal uses Unicode blocks and the same frame data. Its static option disables the decorative animation without changing layout or input behavior. Animation is never required to understand session status.

Native app icons are deterministic raster exports of the approved vector robot, generated with `node scripts/build-brand-assets.mjs`. Set `PLAYWRIGHT_CHROMIUM_EXECUTABLE` when using a local Chromium installation. The repository contains the resulting assets; application startup does not invoke a browser, Python, or any external design workspace.
