//! The canonical palette is validated and embedded at compile time.
include!(concat!(env!("OUT_DIR"), "/brand_colors.rs"));

pub fn terminal_color_reply(code: u8, color: ratatui::style::Color) -> Option<String> {
    match color {
        ratatui::style::Color::Rgb(red, green, blue) => Some(format!(
            "\x1b]{code};rgb:{:04x}/{:04x}/{:04x}\x1b\\",
            u16::from(red) * 257,
            u16::from(green) * 257,
            u16::from(blue) * 257,
        )),
        _ => None,
    }
}
