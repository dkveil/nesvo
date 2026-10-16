//! VT state is interpreted locally; escape sequences never reach the outer terminal.
use ratatui::{
    buffer::Buffer,
    layout::Rect,
    style::{Color, Modifier, Style},
    widgets::Widget,
};

#[derive(Default)]
pub struct Replies {
    enabled: bool,
    pending: Vec<String>,
}

impl Replies {
    fn push(&mut self, reply: String) {
        if self.enabled && self.pending.len() < 16 {
            self.pending.push(reply);
        }
    }
}

impl vt100::Callbacks for Replies {
    fn unhandled_csi(
        &mut self,
        screen: &mut vt100::Screen,
        i1: Option<u8>,
        i2: Option<u8>,
        params: &[&[u16]],
        c: char,
    ) {
        let parameter = params.first().and_then(|p| p.first()).copied().unwrap_or(0);
        if i2.is_some() {
            return;
        }
        match (i1, c, parameter) {
            (None, 'n', 5) => self.push("\x1b[0n".into()),
            (None, 'n', 6) => {
                let (row, col) = screen.cursor_position();
                self.push(format!("\x1b[{};{}R", row + 1, col + 1));
            }
            (None, 'c', 0) => self.push("\x1b[?1;2c".into()),
            (Some(b'>'), 'c', 0) => self.push("\x1b[>0;1;0c".into()),
            _ => {}
        }
    }

    fn unhandled_osc(&mut self, _: &mut vt100::Screen, params: &[&[u8]]) {
        if params.get(1) != Some(&b"?".as_slice()) {
            return;
        }
        match params.first().copied() {
            Some(b"10") => self.push("\x1b]10;rgb:dede/dede/dede\x1b\\".into()),
            Some(b"11") => self.push("\x1b]11;rgb:0b0b/0b0b/0b0b\x1b\\".into()),
            _ => {}
        }
    }
}

pub struct TerminalState {
    parser: vt100::Parser<Replies>,
}

impl TerminalState {
    pub fn new(rows: u16, cols: u16) -> Self {
        Self {
            parser: vt100::Parser::new_with_callbacks(
                rows.max(2),
                cols.max(10),
                3000,
                Replies::default(),
            ),
        }
    }
    pub fn process(&mut self, data: &str, may_reply: bool) -> Vec<String> {
        self.parser.callbacks_mut().enabled = may_reply;
        self.parser.process(data.as_bytes());
        std::mem::take(&mut self.parser.callbacks_mut().pending)
    }
    pub fn resize(&mut self, rows: u16, cols: u16) {
        self.parser.screen_mut().set_size(rows.max(2), cols.max(10));
    }
    pub fn screen(&self) -> &vt100::Screen {
        self.parser.screen()
    }
    pub fn scroll(&mut self, delta: isize) {
        let current = self.screen().scrollback();
        self.parser
            .screen_mut()
            .set_scrollback(current.saturating_add_signed(delta));
    }
    pub fn scroll_to_bottom(&mut self) {
        self.parser.screen_mut().set_scrollback(0);
    }
}

pub struct TerminalWidget<'a>(pub &'a vt100::Screen);

impl Widget for TerminalWidget<'_> {
    fn render(self, area: Rect, buffer: &mut Buffer) {
        let (rows, cols) = self.0.size();
        for row in 0..area.height.min(rows) {
            for col in 0..area.width.min(cols) {
                let Some(cell) = self.0.cell(row, col) else {
                    continue;
                };
                let target = &mut buffer[(area.x + col, area.y + row)];
                let mut style = Style::default()
                    .fg(color(cell.fgcolor(), Color::Rgb(222, 222, 222)))
                    .bg(color(cell.bgcolor(), Color::Rgb(11, 11, 11)));
                for (enabled, modifier) in [
                    (cell.bold(), Modifier::BOLD),
                    (cell.dim(), Modifier::DIM),
                    (cell.italic(), Modifier::ITALIC),
                    (cell.underline(), Modifier::UNDERLINED),
                    (cell.inverse(), Modifier::REVERSED),
                ] {
                    if enabled {
                        style = style.add_modifier(modifier);
                    }
                }
                target.set_style(style);
                if cell.is_wide_continuation() {
                    target.set_symbol(" ");
                    continue;
                }
                // Never draw half a double-width glyph beyond a pane's right edge.
                if cell.is_wide() && col + 1 >= area.width {
                    target.set_symbol(" ");
                } else {
                    target.set_symbol(if cell.has_contents() {
                        cell.contents()
                    } else {
                        " "
                    });
                }
            }
        }
    }
}

fn color(value: vt100::Color, fallback: Color) -> Color {
    match value {
        vt100::Color::Default => fallback,
        vt100::Color::Idx(index) => Color::Indexed(index),
        vt100::Color::Rgb(r, g, b) => Color::Rgb(r, g, b),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ratatui::{Terminal, backend::TestBackend};

    #[test]
    fn renders_screen_cells_not_a_plain_output_log() {
        let mut state = TerminalState::new(4, 20);
        state.process("old\x1b[2J\x1b[H\x1b[31;1mRED\x1b[0m\x1b[2;4H界!", false);
        let mut terminal = Terminal::new(TestBackend::new(20, 4)).unwrap();
        terminal
            .draw(|frame| frame.render_widget(TerminalWidget(state.screen()), frame.area()))
            .unwrap();
        let buffer = terminal.backend().buffer();
        assert_eq!(buffer[(0, 0)].symbol(), "R");
        assert_eq!(buffer[(0, 0)].fg, Color::Indexed(1));
        assert!(buffer[(0, 0)].modifier.contains(Modifier::BOLD));
        assert_eq!(buffer[(3, 1)].symbol(), "界");
        assert_eq!(buffer[(5, 1)].symbol(), "!");
        assert_eq!(buffer[(0, 2)].symbol(), " ");
    }

    #[test]
    fn alternate_screen_restores_primary_screen() {
        let mut state = TerminalState::new(4, 20);
        state.process("shell\x1b[?1049h\x1b[2J\x1b[Heditor", false);
        assert!(state.screen().alternate_screen());
        assert!(state.screen().contents().contains("editor"));
        state.process("\x1b[?1049l", false);
        assert!(state.screen().contents().contains("shell"));
    }

    #[test]
    fn viewers_and_replay_never_answer_queries() {
        let mut state = TerminalState::new(4, 20);
        assert!(
            state
                .process("\x1b[6n\x1b[c\x1b]11;?\x07", false)
                .is_empty()
        );
        let replies = state.process("\x1b[2;3H\x1b[6n", true);
        assert_eq!(replies, vec!["\x1b[2;3R"]);
    }
}
