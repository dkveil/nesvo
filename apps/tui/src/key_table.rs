use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Press {
    code: KeyCode,
    control: bool,
}

pub const fn plain(code: KeyCode) -> Press {
    Press {
        code,
        control: false,
    }
}

pub const fn control(code: KeyCode) -> Press {
    Press {
        code,
        control: true,
    }
}

impl Press {
    fn matches(&self, key: &KeyEvent) -> bool {
        self.code == key.code && self.control == key.modifiers.contains(KeyModifiers::CONTROL)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Binding<A> {
    pub presses: &'static [Press],
    pub hint: &'static str,
    pub label: &'static str,
    pub action: A,
}

pub const fn bind<A>(
    presses: &'static [Press],
    hint: &'static str,
    label: &'static str,
    action: A,
) -> Binding<A> {
    Binding {
        presses,
        hint,
        label,
        action,
    }
}

pub const fn unlisted<A>(presses: &'static [Press], action: A) -> Binding<A> {
    bind(presses, "", "", action)
}

pub fn action<A: Copy>(table: &[Binding<A>], key: &KeyEvent) -> Option<A> {
    table
        .iter()
        .find(|binding| binding.presses.iter().any(|press| press.matches(key)))
        .map(|binding| binding.action)
}

pub fn listed<A>(table: &[Binding<A>]) -> impl Iterator<Item = &Binding<A>> {
    table.iter().filter(|binding| !binding.hint.is_empty())
}

pub fn hints<A>(table: &[Binding<A>]) -> Vec<(&'static str, &'static str)> {
    listed(table)
        .map(|binding| (binding.hint, binding.label))
        .collect()
}

pub fn line<A>(table: &[Binding<A>]) -> String {
    listed(table)
        .map(|binding| format!("{} {}", binding.hint, binding.label))
        .collect::<Vec<_>>()
        .join(" · ")
}

#[cfg(test)]
pub fn assert_unambiguous<A: std::fmt::Debug>(table: &[Binding<A>]) {
    let presses: Vec<&Press> = table.iter().flat_map(|binding| binding.presses).collect();
    for (index, press) in presses.iter().enumerate() {
        assert!(
            !presses[index + 1..].contains(press),
            "{press:?} is bound twice in {table:?}"
        );
    }
    assert!(
        table.first().is_none_or(|binding| !binding.hint.is_empty()),
        "an unlisted binding belongs to a listed one before it: {table:?}"
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    enum Act {
        Move,
        Save,
    }

    const TABLE: [Binding<Act>; 3] = [
        bind(&[plain(KeyCode::Char('j'))], "j k", "move", Act::Move),
        unlisted(&[plain(KeyCode::Char('k'))], Act::Move),
        bind(&[control(KeyCode::Char('s'))], "Ctrl+S", "save", Act::Save),
    ];

    #[test]
    fn key_table_matches_control_exactly_and_lists_only_hinted_bindings() {
        let press = |code, modifiers| KeyEvent::new(code, modifiers);
        assert_eq!(
            action(&TABLE, &press(KeyCode::Char('k'), KeyModifiers::NONE)),
            Some(Act::Move)
        );
        assert_eq!(
            action(&TABLE, &press(KeyCode::Char('s'), KeyModifiers::CONTROL)),
            Some(Act::Save)
        );
        assert_eq!(
            action(&TABLE, &press(KeyCode::Char('s'), KeyModifiers::NONE)),
            None
        );
        assert_eq!(
            action(&TABLE, &press(KeyCode::Char('j'), KeyModifiers::CONTROL)),
            None
        );
        assert_eq!(line(&TABLE), "j k move · Ctrl+S save");
        assert_unambiguous(&TABLE);
    }
}
