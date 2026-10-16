use anyhow::{Result, ensure};
use serde::Serialize;

pub const MAX_GROUPS: usize = 64;

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Group {
    pub id: String,
    pub parent_id: Option<String>,
    pub name: String,
    pub order: u32,
}

pub fn valid_name(name: &str) -> Result<String> {
    let name = name.trim();
    ensure!(
        !name.is_empty() && name.chars().count() <= 80 && !name.chars().any(char::is_control),
        "Use a name between 1 and 80 characters without control characters."
    );
    Ok(name.to_owned())
}

pub fn validate_edit(
    groups: &[Group],
    id: &str,
    parent_id: Option<&str>,
    name: &str,
    order: u32,
) -> Result<String> {
    let name = valid_name(name)?;
    ensure!(
        order <= 1_000_000,
        "Group order must be between 0 and 1000000."
    );
    let mut ancestor = parent_id;
    let mut depth = 0;
    while let Some(parent) = ancestor {
        ensure!(
            parent != id,
            "A group cannot contain itself or one of its ancestors."
        );
        let group = groups
            .iter()
            .find(|group| group.id == parent)
            .ok_or_else(|| anyhow::anyhow!("Parent group does not exist."))?;
        ancestor = group.parent_id.as_deref();
        depth += 1;
        ensure!(depth <= groups.len(), "Group hierarchy contains a cycle.");
    }
    Ok(name)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tree() -> Vec<Group> {
        vec![
            Group {
                id: "root".into(),
                parent_id: None,
                name: "Project".into(),
                order: 0,
            },
            Group {
                id: "child".into(),
                parent_id: Some("root".into()),
                name: "Work".into(),
                order: 0,
            },
        ]
    }

    #[test]
    fn rejects_self_parent_descendant_cycles_missing_parents_and_bad_names() {
        let groups = tree();
        assert!(validate_edit(&groups, "root", Some("root"), "A", 0).is_err());
        assert!(validate_edit(&groups, "root", Some("child"), "A", 0).is_err());
        assert!(validate_edit(&groups, "new", Some("missing"), "A", 0).is_err());
        assert!(validate_edit(&groups, "new", None, "x\x1b[0m", 0).is_err());
        assert!(validate_edit(&groups, "new", None, "A", 1_000_001).is_err());
        assert_eq!(
            validate_edit(&groups, "new", Some("child"), "  東京  ", 0).unwrap(),
            "東京"
        );
    }
}
