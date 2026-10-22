use crate::{model::App, ui};
use crossterm::event::{MouseButton, MouseEvent, MouseEventKind};
use ratatui::{
    Terminal, backend::TestBackend, buffer::Buffer, layout::Rect, style::Style, text::Span,
};

pub struct Selection {
    pub snapshot: Buffer,
    pub area: Rect,
    pub start: (u16, u16),
    pub end: (u16, u16),
    pub dragged: bool,
}
impl Selection {
    fn bounds(&self) -> ((u16, u16), (u16, u16)) {
        if self.start <= self.end {
            (self.start, self.end)
        } else {
            (self.end, self.start)
        }
    }
    pub fn text(&self) -> String {
        let (start, end) = self.bounds();
        let mut lines = Vec::new();
        for y in start.0..=end.0 {
            let left = if y == start.0 { start.1 } else { self.area.x };
            let right = if y == end.0 {
                end.1
            } else {
                self.area.right() - 1
            };
            let mut line = String::new();
            let mut x = self.area.x;
            while x <= right {
                let symbol = self.snapshot[(x, y)].symbol();
                let width = Span::raw(symbol).width().max(1) as u16;
                if x + width > left {
                    line.push_str(symbol);
                }
                x += width;
            }
            lines.push(line.trim_end().to_owned());
        }
        lines.join("\n")
    }
    pub fn render(&self, buffer: &mut Buffer, color: ratatui::style::Color) {
        if !self.dragged || buffer.area != self.snapshot.area {
            return;
        }
        *buffer = self.snapshot.clone();
        let (start, end) = self.bounds();
        for y in start.0..=end.0 {
            for x in self.area.x..self.area.right() {
                if (y, x) >= start && (y, x) <= end {
                    buffer[(x, y)].set_style(Style::default().bg(color));
                }
            }
        }
    }
}

pub fn press(app: &App, mouse: MouseEvent, screen: Rect) -> Option<Selection> {
    if app.dialog.is_some()
        || app.overlay.is_some()
        || mouse.kind != MouseEventKind::Down(MouseButton::Left)
    {
        return None;
    }
    let geometry = ui::geometry(screen, app);
    let point = (mouse.column, mouse.row).into();
    let review = if app.reviews.shown.is_some() {
        crate::ui_review::content_area(app, geometry.review)
    } else {
        crate::review::content_area(app, geometry.review)
    };
    let area = (0..app.leaf_count())
        .filter(|index| app.panes[*index].is_some() && !geometry.panes[*index].is_empty())
        .map(|index| ui::pane_content(geometry.panes[index], ui::immersive(app)))
        .chain(std::iter::once(review))
        .find(|area| area.contains(point))?;
    let mut terminal = Terminal::new(TestBackend::new(screen.width, screen.height)).ok()?;
    terminal.draw(|frame| ui::render(frame, app, 0)).ok()?;
    Some(Selection {
        snapshot: terminal.backend().buffer().clone(),
        area,
        start: (mouse.row, mouse.column),
        end: (mouse.row, mouse.column),
        dragged: false,
    })
}

pub fn drag(selection: &mut Selection, mouse: MouseEvent) {
    selection.end = (
        mouse
            .row
            .clamp(selection.area.y, selection.area.bottom() - 1),
        mouse
            .column
            .clamp(selection.area.x, selection.area.right() - 1),
    );
    selection.dragged |= selection.start != selection.end;
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn reverse_selection_keeps_unicode_and_excludes_other_panes() {
        let mut snapshot = Buffer::empty(Rect::new(0, 0, 20, 4));
        snapshot.set_string(2, 1, "a界b", Style::default());
        snapshot.set_string(2, 2, "żółw", Style::default());
        snapshot.set_string(10, 1, "PRIVATE", Style::default());
        let selection = Selection {
            snapshot,
            area: Rect::new(2, 1, 6, 2),
            start: (2, 4),
            end: (1, 3),
            dragged: true,
        };
        assert_eq!(selection.text(), "界b\nżół");
    }
}
