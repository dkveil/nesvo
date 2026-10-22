#[allow(dead_code)]
#[path = "../src/brand.rs"]
mod brand;
#[allow(dead_code)]
#[path = "../src/theme.rs"]
mod theme;
use ratatui::{
    buffer::Buffer,
    layout::Rect,
    style::{Color, Modifier, Style},
    text::{Line, Span},
    widgets::{Block, Borders, Paragraph, Widget},
};
use serde_json::json;
use theme::*;
const W: u16 = 128;
const H: u16 = 34;
fn fill(b: &mut Buffer, r: Rect, bg: Color) {
    for y in r.y..r.bottom() {
        for x in r.x..r.right() {
            b[(x, y)]
                .set_symbol(" ")
                .set_style(Style::default().fg(TEXT).bg(bg));
        }
    }
}

fn text(b: &mut Buffer, x: u16, y: u16, w: u16, s: &str, c: Color) {
    Paragraph::new(s.to_owned())
        .style(Style::default().fg(c))
        .render(Rect::new(x, y, w, 1), b);
}
fn key(b: &mut Buffer, x: u16, y: u16, k: &str, label: &str) -> u16 {
    let spans = vec![
        Span::styled(
            format!(" {k} "),
            Style::default()
                .fg(TEXT)
                .bg(BORDER)
                .add_modifier(Modifier::BOLD),
        ),
        Span::styled(format!(" {label}  "), Style::default().fg(MUTED)),
    ];
    Paragraph::new(Line::from(spans)).render(Rect::new(x, y, W - x, 1), b);
    x + k.chars().count() as u16 + label.chars().count() as u16 + 5
}
fn divider(b: &mut Buffer, x: u16, y: u16, h: u16, c: Color) {
    for row in y..y + h {
        text(b, x, row, 1, "│", c);
    }
}
fn sidebar(b: &mut Buffer, width: u16, dense: bool) {
    fill(b, Rect::new(0, 0, width, H - 1), SURFACE);
    brand::CompactLogo(Theme::Ultraviolet).render(Rect::new(1, 0, width - 2, 3), b);
    fill(b, Rect::new(1, 4, width - 2, 3), BACKGROUND);
    Block::default()
        .borders(Borders::ALL)
        .border_style(Style::default().fg(BORDER))
        .render(Rect::new(1, 4, width - 2, 3), b);
    text(b, 3, 5, width - 6, "/ Search sessions", MUTED);
    text(b, 2, 8, width - 4, "All  5    Attention  1", MUTED);
    text(b, 2, 10, width - 4, "v nesvo", TEXT);
    let rows = [
        ("Review UI", "Claude · working", SUCCESS),
        ("Fix pairing", "Codex · input needed", WARNING),
        ("Dev server", "Terminal · running", MUTED),
        ("Mobile layout", "Gemini · idle", MUTED),
    ];
    for (i, (name, status, color)) in rows.iter().enumerate() {
        let y = 12 + i as u16 * if dense { 2 } else { 3 };
        if i == 0 {
            fill(
                b,
                Rect::new(0, y, width - 1, if dense { 1 } else { 2 }),
                ACCENT,
            );
        }
        let fg = if i == 0 { BACKGROUND } else { TEXT };
        text(b, 2, y, width - 4, name, fg);
        if !dense {
            text(
                b,
                2,
                y + 1,
                width - 4,
                status,
                if i == 0 { BACKGROUND } else { *color },
            );
        } else {
            text(b, width - 5, y, 3, if i == 1 { " ! " } else { " · " }, fg);
        }
    }
    text(
        b,
        2,
        if dense { 22 } else { 26 },
        width - 4,
        "› personal                 1",
        MUTED,
    );
    if dense {
        text(b, 2, 28, width - 4, "Claude · working", SUCCESS);
        text(b, 2, 29, width - 4, "nesvo / feat/ui", MUTED);
    }
    divider(b, width - 1, 0, H - 1, ACCENT);
}
fn terminal(b: &mut Buffer, x: u16, w: u16, compact: bool) {
    fill(b, Rect::new(x, 0, w, 1), SURFACE);
    text(
        b,
        x + 2,
        0,
        w - 4,
        if compact {
            "nesvo / Review UI   ·   Claude"
        } else {
            " Review UI     Fix pairing     +"
        },
        TEXT,
    );
    text(b, x + 2, 3, w - 4, "Claude Code", PROGRAM_CLAUDE);
    text(b, x + 2, 4, w - 4, "~/dev/nesvo  ·  feat/ui", MUTED);
    text(
        b,
        x + 2,
        7,
        w - 4,
        "> Make session navigation easier to scan.",
        TEXT,
    );
    text(
        b,
        x + 2,
        10,
        w - 4,
        "I will simplify the sidebar and keep",
        TEXT,
    );
    text(
        b,
        x + 2,
        11,
        w - 4,
        "the terminal as the main workspace.",
        TEXT,
    );
    text(b, x + 2, 14, w - 4, "  Read  apps/tui/src/ui.rs", MUTED);
    text(
        b,
        x + 2,
        15,
        w - 4,
        "  Edit  apps/tui/src/sidebar.rs",
        MUTED,
    );
    text(
        b,
        x + 2,
        18,
        w - 4,
        "+ Highlight the complete session row",
        SUCCESS,
    );
    text(
        b,
        x + 2,
        19,
        w - 4,
        "+ Keep keyboard hints on one line",
        SUCCESS,
    );
    text(b, x + 2, 22, w - 4, "Working…", PROGRAM_CLAUDE);
    text(
        b,
        x + 2,
        29,
        w - 4,
        "────────────────────────────────────────────────────────────────────────────────",
        BORDER,
    );
    text(b, x + 2, 30, w - 4, ">", TEXT);
    text(
        b,
        x + 2,
        32,
        w - 4,
        "Illustrative agent output · design fixture",
        MUTED,
    );
}
fn diff(b: &mut Buffer, x: u16, w: u16) {
    divider(b, x, 0, H - 1, BORDER);
    text(b, x + 2, 0, w - 4, "Changes  ·  unstaged", TEXT);
    text(b, x + 2, 2, w - 4, "Auto · nesvo", MUTED);
    fill(b, Rect::new(x + 1, 4, w - 2, 1), SELECTION);
    text(b, x + 2, 4, w - 4, "sidebar.rs              +8 −3", TEXT);
    text(b, x + 2, 5, w - 4, "ui.rs                   +2 −6", MUTED);
    text(b, x + 2, 8, w - 4, "@@ 42 · selected session", MUTED);
    text(b, x + 2, 10, w - 4, " 42   let selected = row.id;", TEXT);
    fill(b, Rect::new(x + 1, 11, w - 2, 1), Color::Rgb(53, 33, 40));
    text(
        b,
        x + 2,
        11,
        w - 4,
        " 43 − highlight(title);",
        Color::Rgb(255, 149, 163),
    );
    fill(b, Rect::new(x + 1, 12, w - 2, 2), Color::Rgb(30, 49, 39));
    text(
        b,
        x + 2,
        12,
        w - 4,
        " 43 + highlight(row);",
        Color::Rgb(154, 230, 174),
    );
    text(
        b,
        x + 2,
        13,
        w - 4,
        " 44 + preserve_focus();",
        Color::Rgb(154, 230, 174),
    );
    text(b, x + 2, 14, w - 4, " 45   render_session();", TEXT);
    text(b, x + 2, 18, w - 4, "··· 18 unchanged lines ···", MUTED);
    text(b, x + 2, 31, w - 4, "2 files · +10 −9", MUTED);
}
fn footer(b: &mut Buffer, focus: bool) {
    fill(b, Rect::new(0, H - 1, W, 1), SURFACE);
    fill(
        b,
        Rect::new(0, H - 1, if focus { 9 } else { 7 }, 1),
        if focus { BORDER } else { ACCENT },
    );
    text(
        b,
        1,
        H - 1,
        9,
        if focus { " SESSION " } else { " MENU " },
        if focus { TEXT } else { BACKGROUND },
    );
    let mut x = 12;
    for (k, l) in if focus {
        vec![("Ctrl+Q", "menu"), ("F4", "diff"), ("z", "full on")]
    } else {
        vec![
            ("Enter", "open"),
            ("/", "search"),
            ("n", "new"),
            ("F4", "diff"),
        ]
    } {
        x = key(b, x, H - 1, k, l);
    }
    text(b, 91, H - 1, 36, "Claude 5h 42% · Codex 7d 28%", MUTED);
}
fn palette(b: &mut Buffer, variant: usize) {
    let (x, y, w, h) = match variant {
        0 => (18, 5, 94, 24),
        1 => (2, 4, 124, 23),
        _ => (29, 6, 70, 22),
    };
    fill(b, Rect::new(x, y, w, h), SURFACE);
    Block::default()
        .borders(Borders::ALL)
        .border_style(Style::default().fg(BORDER))
        .render(Rect::new(x, y, w, h), b);
    fill(b, Rect::new(x + 2, y + 1, w - 4, 3), BACKGROUND);
    Block::default()
        .borders(Borders::ALL)
        .border_style(Style::default().fg(ACCENT))
        .render(Rect::new(x + 2, y + 1, w - 4, 3), b);
    text(b, x + 4, y + 2, w - 8, "/  ui_", TEXT);
    fill(b, Rect::new(x + 3, y + 5, 7, 1), BORDER);
    text(b, x + 4, y + 5, 6, "All  4", TEXT);
    text(
        b,
        x + 13,
        y + 5,
        w - 16,
        "Sessions   Groups   Commands",
        MUTED,
    );
    let lw = if variant == 0 { 48 } else { w - 4 };
    let rows = [
        ("Review UI", "Claude · nesvo / feat/ui", "working"),
        ("Mobile UI", "Gemini · nesvo / mobile", "idle"),
        ("UI regression", "Codex · tests / review", "input needed"),
        ("Review Git changes", "Command · F4", ""),
    ];
    for (i, (name, meta, status)) in rows.iter().enumerate() {
        let ry = y + 7 + i as u16 * 3;
        if i == 0 {
            fill(b, Rect::new(x + 2, ry, lw, 2), SELECTION);
        }
        text(b, x + 4, ry, lw - 4, name, TEXT);
        text(b, x + 4, ry + 1, lw - 4, meta, MUTED);
        if variant != 0 {
            text(
                b,
                x + w - 18,
                ry,
                15,
                status,
                if i == 2 { WARNING } else { SUCCESS },
            );
        }
    }
    if variant == 0 {
        divider(b, x + 52, y + 7, 13, BORDER);
        text(b, x + 55, y + 7, 34, "Review UI", TEXT);
        text(b, x + 55, y + 9, 34, "Claude · working", SUCCESS);
        text(b, x + 55, y + 12, 34, "Make session navigation", MUTED);
        text(b, x + 55, y + 13, 34, "easier to scan.", MUTED);
        text(b, x + 55, y + 16, 34, "+ Complete row highlight", SUCCESS);
        text(b, x + 55, y + 17, 34, "+ One-line keyboard hints", SUCCESS);
    }
    let px = key(b, x + 3, y + h - 2, "↑↓", "select");
    let px = key(b, px, y + h - 2, "Enter", "open");
    key(b, px, y + h - 2, "Esc", "close");
}
fn rgb(c: Color) -> String {
    match c {
        Color::Rgb(r, g, b) => format!("#{r:02x}{g:02x}{b:02x}"),
        _ => "#17171a".into(),
    }
}
fn main() -> anyhow::Result<()> {
    let out = std::path::PathBuf::from(std::env::args().nth(1).expect("output directory"));
    std::fs::create_dir_all(&out)?;
    for variant in 0..3 {
        for search in [false, true] {
            let mut b = Buffer::empty(Rect::new(0, 0, W, H));
            fill(&mut b, Rect::new(0, 0, W, H), BACKGROUND);
            let side = match variant {
                0 => 30,
                1 => 28,
                _ => 0,
            };
            let review = if variant == 1 { 40 } else { 36 };
            if side > 0 {
                sidebar(&mut b, side, variant == 1);
            }
            terminal(&mut b, side, W - side - review, variant != 0);
            diff(&mut b, W - review, review);
            footer(&mut b, variant == 2);
            if search {
                palette(&mut b, variant);
            }
            let cells:Vec<_>=b.content.iter().map(|c|json!({"s":c.symbol(),"fg":rgb(c.fg),"bg":rgb(c.bg),"bold":c.modifier.contains(Modifier::BOLD)})).collect();
            std::fs::write(
                out.join(format!(
                    "{}-{}.json",
                    ["a-calm", "b-compact", "c-focus"][variant],
                    if search { "search" } else { "workspace" }
                )),
                serde_json::to_vec(&json!({"width":W,"height":H,"cells":cells}))?,
            )?;
        }
    }
    Ok(())
}
