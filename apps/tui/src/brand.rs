//! Exact shared block geometry, rendered as two pixels per terminal cell.
use crate::theme::{BACKGROUND, TEXT, Theme};
use ratatui::{buffer::Buffer, layout::Rect, style::Style, widgets::Widget};
use std::time::Duration;

pub struct PixelRect {
    x: i16,
    y: i16,
    width: i16,
    height: i16,
}

pub struct Pose {
    at_ms: u64,
    eye_dx: i16,
    eye_open: bool,
    satellite_dy: i16,
}

include!(concat!(env!("OUT_DIR"), "/brand_logo.rs"));

pub const ROWS: u16 = (PIXEL_HEIGHT / 2) as u16;

pub fn frame_index(elapsed: Duration) -> usize {
    let phase = (elapsed.as_millis() % u128::from(DURATION_MS)) as u64;
    FRAMES
        .iter()
        .rposition(|frame| frame.at_ms <= phase)
        .unwrap_or(0)
}

/// Reserve a fixed masthead only when the logo and all home actions fit.
pub fn area(content: Rect) -> Option<Rect> {
    (content.width >= WIDTH as u16 && content.height >= ROWS + 12).then_some(Rect::new(
        content.x,
        content.y,
        WIDTH as u16,
        ROWS,
    ))
}

pub fn home_offset(content: Rect) -> u16 {
    if area(content).is_some() { ROWS + 1 } else { 0 }
}

fn pixels(frame: usize) -> [[u8; WIDTH]; PIXEL_HEIGHT] {
    let mut pixels = [[0; WIDTH]; PIXEL_HEIGHT];
    for (index, (glyph, origin)) in GLYPHS.iter().zip(ORIGINS).enumerate() {
        for (y, row) in glyph.iter().enumerate() {
            for (x, byte) in row.bytes().enumerate() {
                if byte == b'1' {
                    pixels[y + TOP as usize][x + origin] = if index == 0 { 1 } else { 2 };
                }
            }
        }
    }
    let pose = &FRAMES[frame.min(FRAMES.len() - 1)];
    if pose.eye_open {
        paint(&mut pixels, &EYE, pose.eye_dx, 0, 2);
    } else {
        paint(&mut pixels, &EYELID, 0, 0, 1);
    }
    paint(&mut pixels, &SATELLITE, 0, pose.satellite_dy, 1);
    pixels
}

fn paint(pixels: &mut [[u8; WIDTH]; PIXEL_HEIGHT], rect: &PixelRect, dx: i16, dy: i16, color: u8) {
    for y in rect.y..rect.y + rect.height {
        for x in rect.x..rect.x + rect.width {
            let (x, y) = (x + dx, y + TOP + dy);
            if x >= 0
                && y >= 0
                && let Some(pixel) = pixels
                    .get_mut(y as usize)
                    .and_then(|row| row.get_mut(x as usize))
            {
                *pixel = color;
            }
        }
    }
}

pub struct Logo(pub usize, pub Theme);

impl Widget for Logo {
    fn render(self, area: Rect, buffer: &mut Buffer) {
        if area.width < WIDTH as u16 || area.height < ROWS {
            return;
        }
        let colors = [BACKGROUND, self.1.accent(), TEXT];
        let pixels = pixels(self.0);
        for y in 0..usize::from(ROWS) {
            for x in 0..WIDTH {
                buffer[(area.x + x as u16, area.y + y as u16)]
                    .set_symbol("▀")
                    .set_style(
                        Style::default()
                            .fg(colors[usize::from(pixels[y * 2][x])])
                            .bg(colors[usize::from(pixels[y * 2 + 1][x])]),
                    );
            }
        }
    }
}

/// Compact solid pixels retain the wordmark's top, counters and crossbars.
pub struct CompactLogo(pub Theme);
impl Widget for CompactLogo {
    fn render(self, area: Rect, buffer: &mut Buffer) {
        // Sample each canonical glyph independently so the small wordmark keeps
        // its stems and counters. No satellite, animation or private font glyphs.
        const ROWS: [usize; 6] = [0, 2, 3, 4, 6, 7];
        const COLUMNS: [[usize; 3]; 5] = [[1, 4, 7], [1, 4, 6], [1, 4, 6], [1, 3, 6], [1, 4, 6]];
        let width = 19u16.min(area.width);
        let left = area.x + area.width.saturating_sub(width) / 2;
        for (index, glyph) in GLYPHS.iter().enumerate() {
            let ink = if index == 0 { self.0.accent() } else { TEXT };
            for y in 0..3usize.min(usize::from(area.height)) {
                for (x, source_x) in COLUMNS[index].iter().enumerate() {
                    let column = index * 4 + x;
                    if column >= usize::from(width) {
                        continue;
                    }
                    let top = glyph[ROWS[y * 2]].as_bytes()[*source_x] == b'1';
                    let bottom = glyph[ROWS[y * 2 + 1]].as_bytes()[*source_x] == b'1';
                    buffer[(left + column as u16, area.y + y as u16)]
                        .set_symbol("▀")
                        .set_style(
                            Style::default()
                                .fg(if top { ink } else { crate::theme::SURFACE })
                                .bg(if bottom { ink } else { crate::theme::SURFACE }),
                        );
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shared_keyframes_preserve_original_eye_blink_and_satellite_positions() {
        assert_eq!((WIDTH, PIXEL_HEIGHT, ROWS), (49, 12, 6));
        let initial = pixels(frame_index(Duration::ZERO));
        assert_eq!(initial[6][5], 2);
        assert_eq!(initial[2][8], 1);
        let blink = pixels(frame_index(Duration::from_millis(840)));
        assert_eq!(&blink[6][2..7], &[1; 5]);
        let look_right = pixels(frame_index(Duration::from_millis(1500)));
        assert_eq!(look_right[6][6], 2);
        assert_eq!(look_right[1][8], 1);
        assert_eq!(pixels(frame_index(Duration::from_millis(6000))), initial);
        // The remaining wordmark never moves or changes during the animation.
        for index in 0..FRAMES.len() {
            for (initial_row, row) in initial.iter().zip(pixels(index)) {
                assert_eq!(&initial_row[11..], &row[11..]);
            }
        }
    }

    #[test]
    fn half_block_cells_use_canonical_colors_and_stay_inside_reserved_area() {
        let mut buffer = Buffer::empty(Rect::new(0, 0, 60, 10));
        Logo(0, Theme::Ultraviolet).render(Rect::new(2, 1, WIDTH as u16, ROWS), &mut buffer);
        assert_eq!(buffer[(10, 2)].symbol(), "▀");
        assert_eq!(buffer[(10, 2)].fg, Theme::Ultraviolet.accent());
        assert_eq!(buffer[(10, 2)].bg, BACKGROUND);
        assert_eq!(buffer[(7, 4)].fg, TEXT);
        assert_eq!(buffer[(1, 1)].symbol(), " ");
        assert!(area(Rect::new(0, 0, 48, 30)).is_none());
        assert!(area(Rect::new(0, 0, 60, 17)).is_none());
        Logo(0, Theme::Graphite).render(Rect::new(2, 1, WIDTH as u16, ROWS), &mut buffer);
        assert_eq!(buffer[(10, 2)].fg, Theme::Graphite.accent());
        assert_eq!(buffer[(10, 2)].bg, BACKGROUND);
    }
    #[test]
    fn compact_wordmark_is_nineteen_cells_by_three_without_satellite() {
        let mut buffer = Buffer::empty(Rect::new(0, 0, 30, 5));
        CompactLogo(Theme::Ultraviolet).render(Rect::new(0, 0, 30, 3), &mut buffer);
        assert_eq!(
            buffer
                .content()
                .iter()
                .filter(|c| c.symbol() == "▀")
                .count(),
            45
        );
        assert!((0..30).all(|x| buffer[(x, 3)].symbol() == " "));
    }
}
