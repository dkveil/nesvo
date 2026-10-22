pub const BACKLOG_BYTES: usize = 128 * 1024;
const DECID_FINAL: u8 = b'Z';

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Page<'a> {
    pub format: &'static str,
    pub data: &'a str,
    pub from_cursor: u64,
    pub next_cursor: u64,
    pub floor_cursor: u64,
    pub head_cursor: u64,
    pub gap: bool,
    pub more: bool,
}
pub fn page(backlog: &str, head: u64, after: Option<u64>, max: usize) -> anyhow::Result<Page<'_>> {
    use crate::api_error::Error;
    if !(1..=8192).contains(&max) {
        return Err(Error::new("invalid_argument", "Read limit must be 1–8192 bytes").into());
    }
    let floor = head.saturating_sub(backlog.len() as u64);
    let gap = after.is_some_and(|at| at < floor);
    let from = match after {
        Some(at) if at > head => {
            return Err(
                Error::new("invalid_cursor", "Cursor is ahead of this process output").into(),
            );
        }
        Some(at) => at.max(floor),
        None => floor + (backlog.len().saturating_sub(max) as u64),
    };
    let mut start = (from - floor) as usize;
    if after.is_some() && !backlog.is_char_boundary(start) {
        return Err(Error::new("invalid_cursor", "Cursor splits a UTF-8 character").into());
    }
    while !backlog.is_char_boundary(start) {
        start += 1;
    }
    let mut end = (start + max).min(backlog.len());
    while !backlog.is_char_boundary(end) {
        end -= 1;
    }
    if end == start && end < backlog.len() {
        return Err(Error::new(
            "invalid_argument",
            "Read limit cannot hold the next UTF-8 character",
        )
        .into());
    }
    Ok(Page {
        format: "terminalReplay",
        data: &backlog[start..end],
        from_cursor: floor + start as u64,
        next_cursor: floor + end as u64,
        floor_cursor: floor,
        head_cursor: head,
        gap,
        more: end < backlog.len(),
    })
}

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

pub fn replay_history_without_terminal_queries(text: &str) -> String {
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
            DECID_FINAL => true,
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
                let query = is_decrqss_or_xtgettcap_request(bytes[end], body);
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

fn is_decrqss_or_xtgettcap_request(final_byte: u8, body: &[u8]) -> bool {
    final_byte == b'q' && (body.ends_with(b"$") || body.ends_with(b"+"))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn incremental_pages_have_explicit_gaps_utf8_boundaries_and_bounded_json() {
        let mut backlog = String::new();
        let text = "x".repeat(BACKLOG_BYTES + 20) + "猫😀\n";
        bounded_append(&mut backlog, &text);
        let head = text.len() as u64;
        let first = page(&backlog, head, Some(0), 4096).unwrap();
        assert!(first.gap);
        assert!(first.more);
        let next = page(&backlog, head, Some(first.next_cursor), 4096).unwrap();
        assert!(!next.gap);
        assert_eq!(next.from_cursor, first.next_cursor);
        assert!(page(&backlog, head, Some(head + 1), 4096).is_err());
        let tail = page(&backlog, head, None, 6).unwrap();
        assert_eq!(tail.data, "😀\n");
        assert!(page(&backlog, head, Some(head - 2), 4096).is_err());
        assert!(page(&backlog, head, Some(head - 5), 1).is_err());
        let worst = "\x00".repeat(8192);
        assert!(
            serde_json::to_vec(&page(&worst, worst.len() as u64, None, 8192).unwrap())
                .unwrap()
                .len()
                < crate::wire::MAX_PLAINTEXT - 2048
        );
        assert!(page(&backlog, head, None, 8193).is_err());
    }
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
        assert_eq!(
            replay_history_without_terminal_queries(history),
            "hello\x1b[31mredworld\x1b[0m"
        );
        assert_eq!(
            replay_history_without_terminal_queries("zażółć 🦀\x1b[6n"),
            "zażółć 🦀"
        );
        assert_eq!(
            replay_history_without_terminal_queries(
                "a\x1bP$qm\x1b\\b\x1bP+q544e\x1b\\c\x1bPqDRAW\x1b\\"
            ),
            "abc\x1bPqDRAW\x1b\\"
        );
    }
}
