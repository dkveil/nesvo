use serde_json::Value;
use std::{env, error::Error, fs, path::PathBuf};

fn main() -> Result<(), Box<dyn Error>> {
    let brand = PathBuf::from(env::var("CARGO_MANIFEST_DIR")?).join("../../packages/brand");
    let source = brand.join("tokens.json");
    println!("cargo:rerun-if-changed={}", source.display());
    let tokens: Value = serde_json::from_str(&fs::read_to_string(source)?)?;
    let mut generated = String::from("// Generated from packages/brand/tokens.json.\n");
    for (name, token) in [
        ("BACKGROUND", "background"),
        ("SURFACE", "surface"),
        ("BORDER", "border"),
        ("TEXT", "text"),
        ("MUTED", "muted"),
        ("FAINT", "faint"),
        ("ACCENT", "accent"),
        ("BRAND_MUTED", "brandMuted"),
        ("SUCCESS", "success"),
        ("WARNING", "warning"),
        ("DANGER", "danger"),
        ("SELECTION", "selection"),
        ("PROGRAM_TERMINAL", "programTerminal"),
        ("PROGRAM_CLAUDE", "programClaude"),
        ("PROGRAM_GEMINI", "programGemini"),
        ("PROGRAM_CODEX", "programCodex"),
    ] {
        let color = tokens["colors"][token]
            .as_str()
            .ok_or_else(|| format!("Missing brand color: {token}"))?;
        if color.len() != 7 || !color.starts_with('#') || !color[1..].is_ascii() {
            return Err(format!("Brand color {token} must be #RRGGBB").into());
        }
        let rgb = u32::from_str_radix(&color[1..], 16)?;
        let (red, green, blue) = ((rgb >> 16) & 255, (rgb >> 8) & 255, rgb & 255);
        generated.push_str(&format!(
            "pub const {name}: ratatui::style::Color = ratatui::style::Color::Rgb({red}, {green}, {blue});\n"
        ));
    }
    let output = PathBuf::from(env::var("OUT_DIR")?).join("brand_colors.rs");
    let themes_source = brand.join("themes.json");
    println!("cargo:rerun-if-changed={}", themes_source.display());
    let themes: Value = serde_json::from_str(&fs::read_to_string(themes_source)?)?;
    for theme in themes["themes"].as_array().ok_or("Missing themes")? {
        let id = theme["id"].as_str().ok_or("Missing theme id")?;
        if id == "ultraviolet" {
            continue;
        }
        for token in ["accent", "selection"] {
            let color = theme["colors"][token]
                .as_str()
                .ok_or("Missing theme color")?;
            if color.len() != 7 || !color.starts_with('#') || !color[1..].is_ascii() {
                return Err("Invalid theme color".into());
            }
            let rgb = u32::from_str_radix(&color[1..], 16)?;
            let constant = format!("{}_{}", id.to_uppercase(), token.to_uppercase());
            generated.push_str(&format!("pub const {constant}: ratatui::style::Color = ratatui::style::Color::Rgb({}, {}, {});\n", (rgb >> 16) & 255, (rgb >> 8) & 255, rgb & 255));
        }
    }
    fs::write(output, generated)?;
    generate_logo(&brand)?;
    Ok(())
}

fn generate_logo(brand: &std::path::Path) -> Result<(), Box<dyn Error>> {
    let source = brand.join("logo.json");
    println!("cargo:rerun-if-changed={}", source.display());
    let logo: Value = serde_json::from_str(&fs::read_to_string(source)?)?;
    let glyphs = logo["glyphs"].as_array().ok_or("Missing logo glyphs")?;
    let origins = logo["origins"].as_array().ok_or("Missing logo origins")?;
    if glyphs.is_empty() || glyphs.len() != origins.len() {
        return Err("Logo glyphs and origins must correspond".into());
    }
    let mut generated = String::from("// Generated from packages/brand/logo.json.\n");
    generated.push_str("pub const GLYPHS: &[&[&str]] = &[\n");
    let mut width = 0usize;
    let mut height = 0usize;
    for (glyph, origin) in glyphs.iter().zip(origins) {
        let rows = glyph.as_array().ok_or("Invalid logo glyph")?;
        let origin = origin
            .as_u64()
            .filter(|origin| *origin < 256)
            .ok_or("Invalid logo origin")? as usize;
        generated.push_str("&[");
        height = height.max(rows.len());
        for row in rows {
            let text = row.as_str().ok_or("Invalid logo row")?;
            if !text.bytes().all(|byte| matches!(byte, b'0' | b'1')) {
                return Err("Logo glyphs must contain only 0 and 1".into());
            }
            width = width.max(origin + text.len());
            generated.push_str(&format!("{text:?},"));
        }
        generated.push_str("],\n");
    }
    generated.push_str("] ;\npub const ORIGINS: &[usize] = &[");
    for origin in origins {
        generated.push_str(&format!(
            "{},",
            origin.as_u64().ok_or("Invalid logo origin")?
        ));
    }
    generated.push_str("];\n");
    for (name, field) in [
        ("EYE", "eye"),
        ("EYELID", "eyelid"),
        ("SATELLITE", "satellite"),
    ] {
        let rect = &logo[field];
        let x = integer(rect, "x")?;
        let y = integer(rect, "y")?;
        let width = integer(rect, "width")?;
        let height = integer(rect, "height")?;
        if width < 1 || height < 1 {
            return Err(format!("Invalid {field} dimensions").into());
        }
        generated.push_str(&format!(
            "pub const {name}: PixelRect = PixelRect {{ x: {x}, y: {y}, width: {width}, height: {height} }};\n"
        ));
    }
    let duration = logo["motion"]["durationMs"]
        .as_u64()
        .filter(|ms| *ms > 0)
        .ok_or("Invalid logo motion duration")?;
    let frames = logo["motion"]["frames"]
        .as_array()
        .filter(|frames| !frames.is_empty())
        .ok_or("Missing logo keyframes")?;
    let mut min_y = 0i64;
    let mut previous_time = None;
    generated.push_str(&format!(
        "pub const DURATION_MS: u64 = {duration};\npub const FRAMES: &[Pose] = &[\n"
    ));
    for frame in frames {
        let at = frame["atMs"].as_u64().ok_or("Invalid frame time")?;
        if at >= duration
            || previous_time.is_some_and(|previous| previous >= at)
            || (previous_time.is_none() && at != 0)
        {
            return Err("Logo frames must start at zero and increase within duration".into());
        }
        previous_time = Some(at);
        let dx = integer(frame, "eyeDx")?;
        let open = frame["eyeOpen"].as_bool().ok_or("Invalid eye keyframe")?;
        let dy = integer(frame, "satelliteDy")?;
        min_y = min_y.min(integer(&logo["satellite"], "y")? + dy);
        generated.push_str(&format!(
            "Pose {{ at_ms: {at}, eye_dx: {dx}, eye_open: {open}, satellite_dy: {dy} }},\n"
        ));
    }
    let top = ((-min_y as usize).div_ceil(2)) * 2;
    let height = (height + top).div_ceil(2) * 2;
    if width > 256 || height > 64 {
        return Err("Logo exceeds bounded terminal geometry".into());
    }
    generated.push_str(&format!("] ;\npub const WIDTH: usize = {width};\npub const PIXEL_HEIGHT: usize = {height};\npub const TOP: i16 = {top};\n"));
    fs::write(
        PathBuf::from(env::var("OUT_DIR")?).join("brand_logo.rs"),
        generated,
    )?;
    Ok(())
}

fn integer(value: &Value, field: &str) -> Result<i64, Box<dyn Error>> {
    let number = value[field]
        .as_i64()
        .ok_or_else(|| format!("Missing logo integer: {field}"))?;
    if !(-256..=256).contains(&number) {
        return Err(format!("Logo {field} is outside the supported geometry").into());
    }
    Ok(number)
}
