use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};

/// Windows console layouts report AltGr text as Ctrl+Alt plus its Unicode scalar.
/// Normalize that otherwise unencodable text before shortcuts or PTY encoding.
/// ASCII control chords, other modifier combinations and release kinds stay intact.
pub fn normalize_key(key: KeyEvent) -> KeyEvent {
    normalize_altgr(key, cfg!(windows))
}

fn normalize_altgr(mut key: KeyEvent, windows: bool) -> KeyEvent {
    if windows
        && key.modifiers & !KeyModifiers::SHIFT == KeyModifiers::CONTROL | KeyModifiers::ALT
        && matches!(key.code, KeyCode::Char(c) if !c.is_ascii() && !c.is_control())
    {
        key.modifiers
            .remove(KeyModifiers::CONTROL | KeyModifiers::ALT);
    }
    key
}

/// Encode key events for the inner PTY, honoring its cursor-key mode.
pub fn encode_key(key: KeyEvent, screen: &vt100::Screen) -> Option<String> {
    let control = key.modifiers.contains(KeyModifiers::CONTROL);
    let alt = key.modifiers.contains(KeyModifiers::ALT);
    let shift = key.modifiers.contains(KeyModifiers::SHIFT);
    let modifier = 1 + u8::from(shift) + 2 * u8::from(alt) + 4 * u8::from(control);
    let mut encoded = match key.code {
        KeyCode::Char(c) if control => {
            let value = match c.to_ascii_lowercase() {
                'a'..='z' => (c.to_ascii_lowercase() as u8) - b'a' + 1,
                ' ' | '@' | '2' => 0,
                '[' | '3' => 27,
                '\\' | '4' => 28,
                ']' | '5' => 29,
                '^' | '6' => 30,
                '_' | '7' => 31,
                '?' | '8' => 127,
                _ => return None,
            };
            char::from(value).to_string()
        }
        KeyCode::Char(c) => c.to_string(),
        KeyCode::Enter => "\r".into(),
        KeyCode::Backspace => "\x7f".into(),
        KeyCode::Tab => "\t".into(),
        KeyCode::BackTab => "\x1b[Z".into(),
        KeyCode::Esc => "\x1b".into(),
        KeyCode::Up
        | KeyCode::Down
        | KeyCode::Right
        | KeyCode::Left
        | KeyCode::Home
        | KeyCode::End => {
            let suffix = match key.code {
                KeyCode::Up => 'A',
                KeyCode::Down => 'B',
                KeyCode::Right => 'C',
                KeyCode::Left => 'D',
                KeyCode::Home => 'H',
                _ => 'F',
            };
            return Some(if modifier > 1 {
                format!("\x1b[1;{modifier}{suffix}")
            } else if screen.application_cursor() {
                format!("\x1bO{suffix}")
            } else {
                format!("\x1b[{suffix}")
            });
        }
        KeyCode::Insert
        | KeyCode::Delete
        | KeyCode::PageUp
        | KeyCode::PageDown
        | KeyCode::F(5..=12) => {
            let number = match key.code {
                KeyCode::Insert => 2,
                KeyCode::Delete => 3,
                KeyCode::PageUp => 5,
                KeyCode::PageDown => 6,
                KeyCode::F(5) => 15,
                KeyCode::F(6) => 17,
                KeyCode::F(7) => 18,
                KeyCode::F(8) => 19,
                KeyCode::F(9) => 20,
                KeyCode::F(10) => 21,
                KeyCode::F(11) => 23,
                _ => 24,
            };
            return Some(if modifier > 1 {
                format!("\x1b[{number};{modifier}~")
            } else {
                format!("\x1b[{number}~")
            });
        }
        KeyCode::F(number @ 1..=4) => {
            let suffix = char::from(b'P' + number - 1);
            return Some(if modifier > 1 {
                format!("\x1b[1;{modifier}{suffix}")
            } else {
                format!("\x1bO{suffix}")
            });
        }
        _ => return None,
    };
    if alt {
        encoded.insert(0, '\x1b');
    }
    Some(encoded)
}

pub fn encode_paste(text: &str, screen: &vt100::Screen) -> String {
    // Remove embedded escapes so a paste cannot terminate its own bracket.
    let text = text
        .replace('\x1b', "")
        .replace("\r\n", "\n")
        .replace('\r', "\n");
    if screen.bracketed_paste() {
        format!("\x1b[200~{text}\x1b[201~")
    } else {
        text.replace('\n', "\r")
    }
}

/// Forward wheel gestures only when the inner application requests mouse input.
pub fn encode_wheel(screen: &vt100::Screen, up: bool, col: u16, row: u16) -> Option<String> {
    if screen.mouse_protocol_mode() == vt100::MouseProtocolMode::None {
        return None;
    }
    let button = if up { 64 } else { 65 };
    Some(match screen.mouse_protocol_encoding() {
        vt100::MouseProtocolEncoding::Sgr => format!("\x1b[<{button};{};{}M", col + 1, row + 1),
        encoding => {
            let max = if encoding == vt100::MouseProtocolEncoding::Default {
                94
            } else {
                2014
            };
            format!(
                "\x1b[M{}{}{}",
                char::from_u32(button + 32)?,
                char::from_u32(u32::from(col.min(max)) + 33)?,
                char::from_u32(u32::from(row.min(max)) + 33)?
            )
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn windows_altgr_preserves_unicode_shift_kind_and_state_without_escape_or_control_bytes() {
        use crossterm::event::{KeyEventKind, KeyEventState};
        let parser = vt100::Parser::new(24, 80, 0);
        for (character, shift) in [('ż', KeyModifiers::NONE), ('Ó', KeyModifiers::SHIFT)] {
            for kind in [
                KeyEventKind::Press,
                KeyEventKind::Repeat,
                KeyEventKind::Release,
            ] {
                let mut key = KeyEvent::new_with_kind(
                    KeyCode::Char(character),
                    KeyModifiers::CONTROL | KeyModifiers::ALT | shift,
                    kind,
                );
                key.state = KeyEventState::CAPS_LOCK;
                let normalized = normalize_altgr(key, true);
                assert_eq!(normalized.code, key.code);
                assert_eq!(normalized.kind, kind);
                assert_eq!(normalized.state, key.state);
                assert_eq!(normalized.modifiers, shift);
                assert_eq!(
                    encode_key(normalized, parser.screen()),
                    Some(character.to_string())
                );
                assert_eq!(normalize_altgr(key, false), key);
            }
        }
    }

    #[test]
    fn altgr_normalization_preserves_ascii_shortcuts_and_distinct_modifier_combinations() {
        let parser = vt100::Parser::new(24, 80, 0);
        for (code, modifiers) in [
            (KeyCode::Char('q'), KeyModifiers::CONTROL),
            (
                KeyCode::Char('a'),
                KeyModifiers::CONTROL | KeyModifiers::ALT,
            ),
            (KeyCode::Char('ż'), KeyModifiers::CONTROL),
            (KeyCode::Char('ż'), KeyModifiers::ALT),
            (
                KeyCode::Char('ż'),
                KeyModifiers::CONTROL | KeyModifiers::ALT | KeyModifiers::SUPER,
            ),
            (
                KeyCode::Char('\u{85}'),
                KeyModifiers::CONTROL | KeyModifiers::ALT,
            ),
            (KeyCode::F(4), KeyModifiers::CONTROL | KeyModifiers::ALT),
            (KeyCode::Enter, KeyModifiers::CONTROL | KeyModifiers::ALT),
        ] {
            let key = KeyEvent::new(code, modifiers);
            assert_eq!(normalize_altgr(key, true), key);
        }
        assert_eq!(
            encode_key(
                normalize_altgr(
                    KeyEvent::new(
                        KeyCode::Char('a'),
                        KeyModifiers::CONTROL | KeyModifiers::ALT
                    ),
                    true
                ),
                parser.screen()
            ),
            Some("\x1b\x01".into()),
        );
    }

    #[test]
    fn encodes_controls_and_application_arrows() {
        let mut parser = vt100::Parser::new(24, 80, 0);
        assert_eq!(
            encode_key(
                KeyEvent::new(KeyCode::Char('c'), KeyModifiers::CONTROL),
                parser.screen()
            ),
            Some("\x03".into())
        );
        assert_eq!(
            encode_key(
                KeyEvent::new(KeyCode::Up, KeyModifiers::NONE),
                parser.screen()
            ),
            Some("\x1b[A".into())
        );
        parser.process(b"\x1b[?1h");
        assert_eq!(
            encode_key(
                KeyEvent::new(KeyCode::Up, KeyModifiers::NONE),
                parser.screen()
            ),
            Some("\x1bOA".into())
        );
        assert_eq!(
            encode_key(
                KeyEvent::new(KeyCode::Left, KeyModifiers::CONTROL),
                parser.screen()
            ),
            Some("\x1b[1;5D".into())
        );
    }

    #[test]
    fn brackets_pastes_only_when_requested_and_strips_nested_escape() {
        let mut parser = vt100::Parser::new(24, 80, 0);
        assert_eq!(encode_paste("a\r\nb", parser.screen()), "a\rb");
        parser.process(b"\x1b[?2004h");
        assert_eq!(
            encode_paste("a\n\x1b[201~b", parser.screen()),
            "\x1b[200~a\n[201~b\x1b[201~"
        );
    }
}
