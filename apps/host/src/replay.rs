//! Bounded transcript storage and historical terminal-query filtering.

pub const BACKLOG_BYTES: usize = 128 * 1024;

pub fn bounded_append(backlog: &mut String, data: &str) {
    backlog.push_str(data);
    if backlog.len() > BACKLOG_BYTES {
        let mut cut = backlog.len() - BACKLOG_BYTES;
        while !backlog.is_char_boundary(cut) {
            cut += 1;
        }
        backlog.drain(..cut);
    }
}

pub fn output_chunks(text: &str) -> impl Iterator<Item = &str> {
    let mut remaining = text;
    std::iter::from_fn(move || {
        if remaining.is_empty() {
            return None;
        }
        let mut length = remaining.len().min(4096);
        while !remaining.is_char_boundary(length) {
            length -= 1;
        }
        let (chunk, tail) = remaining.split_at(length);
        remaining = tail;
        Some(chunk)
    })
}

// Replaying a terminal query must not provoke a fresh response into the running
// shell. Preserve drawing escapes, but remove historical report requests.
pub fn replay_history(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut output = String::with_capacity(text.len());
    let mut index = 0;
    let mut start = 0;
    while index + 1 < bytes.len() {
        if bytes[index] != 0x1b {
            index += 1;
            continue;
        }
        let mut end = index + 2;
        let remove = match bytes[index + 1] {
            b'Z' => true, // DECID device attributes.
            b'[' => {
                while end < bytes.len() && !(0x40..=0x7e).contains(&bytes[end]) {
                    end += 1;
                }
                if end >= bytes.len() {
                    break;
                }
                let final_byte = bytes[end];
                let body = &bytes[index + 2..end];
                end += 1;
                matches!(final_byte, b'n' | b'c' | b't')
                    || (final_byte == b'p' && body.ends_with(b"$"))
                    || (final_byte == b'u' && body.starts_with(b"?"))
            }
            b']' => {
                while end < bytes.len()
                    && bytes[end] != 7
                    && !(bytes[end] == 0x1b && bytes.get(end + 1) == Some(&b'\\'))
                {
                    end += 1;
                }
                if end >= bytes.len() {
                    break;
                }
                let query = bytes[index + 2..end].windows(2).any(|part| part == b";?");
                end += if bytes[end] == 7 { 1 } else { 2 };
                query
            }
            b'P' => {
                while end < bytes.len() && !(0x40..=0x7e).contains(&bytes[end]) {
                    end += 1;
                }
                if end >= bytes.len() {
                    break;
                }
                let body = &bytes[index + 2..end];
                let query = bytes[end] == b'q' && (body.ends_with(b"$") || body.ends_with(b"+"));
                // DECRQSS ($q) and XTGETTCAP (+q) request replies. Preserve
                // drawing DCS strings such as sixel, including their payload.
                while end + 1 < bytes.len() && !(bytes[end] == 0x1b && bytes[end + 1] == b'\\') {
                    end += 1;
                }
                if end + 1 >= bytes.len() {
                    break;
                }
                end += 2;
                query
            }
            _ => false,
        };
        if remove {
            output.push_str(&text[start..index]);
            start = end;
        }
        index = end;
    }
    output.push_str(&text[start..]);
    output
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn backlog_and_chunks_preserve_utf8_and_stay_bounded() {
        let text = "zażółć 🦀 東京\n".repeat(20000);
        let mut backlog = String::new();
        bounded_append(&mut backlog, &text);
        assert!(backlog.len() <= BACKLOG_BYTES);
        assert!(text.ends_with(&backlog));
        assert_eq!(output_chunks(&backlog).collect::<String>(), backlog);
        assert!(output_chunks(&backlog).all(|chunk| chunk.len() <= 4096));
    }
    #[test]
    fn replay_preserves_drawing_but_never_reissues_terminal_queries() {
        let history = "hello\x1b[31mred\x1b[6n\x1b[>0c\x1b[?1$p\x1b]10;?\x07world\x1b[0m";
        assert_eq!(replay_history(history), "hello\x1b[31mredworld\x1b[0m");
        assert_eq!(replay_history("zażółć 🦀\x1b[6n"), "zażółć 🦀");
        assert_eq!(
            replay_history("a\x1bP$qm\x1b\\b\x1bP+q544e\x1b\\c\x1bPqDRAW\x1b\\"),
            "abc\x1bPqDRAW\x1b\\"
        );
    }
}
