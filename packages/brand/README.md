# nesvo — Ultraviolet

The shared visual contract for the existing mobile, web and Rust terminal clients.

- `tokens.json` defines semantic colors. Platform adapters consume these values.
- `themes.json` defines presentation variants over those tokens. Ultraviolet remains the default; Graphite uses a neutral accent and selection while preserving text, backgrounds and status colors. The terminal menu currently exposes this choice; mobile uses Ultraviolet.
- `logo.json` contains the approved SVG paths, matching terminal pixel glyphs and step-based motion frames.
- `assets/nesvo-logo.svg` is the original static vector mark.
- `assets/nesvo-logo-animated.svg` is the original six-second animated vector mark, including its reduced-motion fallback.

The robot replaces the first `n`; the wordmark must remain geometric, not rendered with a substitute font. Its body and the other letters share an eight-pixel height and baseline. During each blink, fill the complete five-pixel visor with the accent color. Only the eye and detached pixel move.

Frames are piecewise constant and repeat every 6,000 ms. Inactive or reduced-motion interfaces render the first frame without a timer. Consumers must keep layout dimensions fixed throughout the cycle. No application reads design-session files or invokes Python at runtime.
