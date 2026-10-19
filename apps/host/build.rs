use std::{
    collections::hash_map::DefaultHasher,
    fs,
    hash::{Hash, Hasher},
    path::Path,
};

fn hash_tree(path: &Path, hash: &mut DefaultHasher) {
    println!("cargo:rerun-if-changed={}", path.display());
    if path.is_dir() {
        let mut children: Vec<_> = fs::read_dir(path)
            .unwrap()
            .map(|e| e.unwrap().path())
            .collect();
        children.sort();
        for child in children {
            hash_tree(&child, hash);
        }
    } else {
        path.file_name().unwrap().hash(hash);
        fs::read(path).unwrap().hash(hash);
    }
}

fn main() {
    let mut hash = DefaultHasher::new();
    for path in [
        "src",
        "status-rules",
        "Cargo.toml",
        "../../Cargo.toml",
        "../../Cargo.lock",
        "../../crates/nesvo-wire",
        "../../skills/nesvo-harness/SKILL.md",
    ] {
        hash_tree(Path::new(path), &mut hash);
    }
    println!("cargo:rustc-env=NESVO_BUILD_ID={:016x}", hash.finish());
}
