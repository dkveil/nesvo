use serde_json::Value;

const PRINT_WIDTH: usize = 100;

pub fn render_json(value: &Value) -> String {
    render(value, 0, 0, 0) + "\n"
}

fn render(value: &Value, indent: usize, used: usize, trailing: usize) -> String {
    let inner = " ".repeat(indent + 2);
    match value {
        Value::Object(map) if !map.is_empty() => {
            let entries: Vec<_> = map
                .iter()
                .enumerate()
                .map(|(index, (key, value))| {
                    let key = format!("{}: ", Value::String(key.clone()));
                    let trailing = usize::from(index + 1 < map.len());
                    let used = inner.len() + key.chars().count();
                    format!("{inner}{key}{}", render(value, indent + 2, used, trailing))
                })
                .collect();
            format!("{{\n{}\n{}}}", entries.join(",\n"), " ".repeat(indent))
        }
        Value::Array(items) if !items.is_empty() => {
            if items
                .iter()
                .all(|item| !item.is_object() && !item.is_array())
            {
                let flat: Vec<_> = items.iter().map(Value::to_string).collect();
                let flat = format!("[{}]", flat.join(", "));
                if used + flat.chars().count() + trailing <= PRINT_WIDTH {
                    return flat;
                }
            }
            let entries: Vec<_> = items
                .iter()
                .enumerate()
                .map(|(index, item)| {
                    let trailing = usize::from(index + 1 < items.len());
                    format!("{inner}{}", render(item, indent + 2, inner.len(), trailing))
                })
                .collect();
            format!("[\n{}\n{}]", entries.join(",\n"), " ".repeat(indent))
        }
        scalar => scalar.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::render_json;
    use serde_json::json;

    #[test]
    fn short_scalar_arrays_stay_inline_and_long_ones_wrap_like_prettier() {
        assert_eq!(
            render_json(&json!({"a":["x","y"],"b":{}})),
            "{\n  \"a\": [\"x\", \"y\"],\n  \"b\": {}\n}\n"
        );
        let long: Vec<String> = (0..20).map(|index| format!("item-{index}")).collect();
        assert!(render_json(&json!({ "a": long })).starts_with("{\n  \"a\": [\n    \"item-0\",\n"));
    }
}
