include!(concat!(env!("OUT_DIR"), "/brand_colors.rs"));

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Theme {
    #[default]
    Ultraviolet,
    Graphite,
    Ocean,
    Sage,
    Amber,
    Rose,
}

impl Theme {
    pub const ALL: [Self; 6] = [
        Self::Ultraviolet,
        Self::Graphite,
        Self::Ocean,
        Self::Sage,
        Self::Amber,
        Self::Rose,
    ];

    pub const fn label(self) -> &'static str {
        match self {
            Self::Ultraviolet => "Ultraviolet",
            Self::Graphite => "Graphite",
            Self::Ocean => "Ocean",
            Self::Sage => "Sage",
            Self::Amber => "Amber",
            Self::Rose => "Rose",
        }
    }

    pub const fn accent(self) -> ratatui::style::Color {
        match self {
            Self::Ultraviolet => ACCENT,
            Self::Graphite => GRAPHITE_ACCENT,
            Self::Ocean => OCEAN_ACCENT,
            Self::Sage => SAGE_ACCENT,
            Self::Amber => AMBER_ACCENT,
            Self::Rose => ROSE_ACCENT,
        }
    }

    pub const fn selection(self) -> ratatui::style::Color {
        match self {
            Self::Ultraviolet => SELECTION,
            Self::Graphite => GRAPHITE_SELECTION,
            Self::Ocean => OCEAN_SELECTION,
            Self::Sage => SAGE_SELECTION,
            Self::Amber => AMBER_SELECTION,
            Self::Rose => ROSE_SELECTION,
        }
    }
}
