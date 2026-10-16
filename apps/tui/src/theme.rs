//! The canonical palette is validated and embedded at compile time.
include!(concat!(env!("OUT_DIR"), "/brand_colors.rs"));

/// Accent variants share terminal ink, backgrounds and semantic status colors.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Theme {
    #[default]
    Ultraviolet,
    Graphite,
}

impl Theme {
    pub const ALL: [Self; 2] = [Self::Ultraviolet, Self::Graphite];

    pub const fn label(self) -> &'static str {
        match self {
            Self::Ultraviolet => "Ultraviolet",
            Self::Graphite => "Graphite",
        }
    }

    pub const fn accent(self) -> ratatui::style::Color {
        match self {
            Self::Ultraviolet => ACCENT,
            Self::Graphite => GRAPHITE_ACCENT,
        }
    }

    pub const fn selection(self) -> ratatui::style::Color {
        match self {
            Self::Ultraviolet => SELECTION,
            Self::Graphite => GRAPHITE_SELECTION,
        }
    }
}
