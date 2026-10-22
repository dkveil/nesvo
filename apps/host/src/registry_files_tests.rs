use super::*;
use crate::process::display_path;
use serde::Deserialize;

struct Scratch(PathBuf);

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn scratch() -> Scratch {
    let path = std::env::temp_dir().join(format!(
        "nesvo-registry-files-{}",
        hex::encode(crate::wire::random::<8>())
    ));
    std::fs::create_dir_all(&path).unwrap();
    Scratch(PathBuf::from(display_path(&path.canonicalize().unwrap())))
}

fn names(directory: &Path) -> Vec<String> {
    let mut names: Vec<String> = std::fs::read_dir(directory)
        .unwrap()
        .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    names.sort();
    names
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
struct Counter {
    version: u32,
    values: Vec<u32>,
}

fn counter(directory: &Path) -> Result<Registry<Counter>> {
    Registry::open(
        directory,
        "counter.json",
        "Counter registry",
        1024,
        || Counter {
            version: 1,
            values: Vec::new(),
        },
        |counter| counter.version == 1,
    )
}

#[test]
fn owner_only_admits_the_owner_and_refuses_scoped_callers_with_their_scope() {
    assert!(owner_only(&Authority::Owner, |_| unreachable!()).is_ok());
    for authority in [
        Authority::Session {
            id: "session".into(),
            scope_id: "scope".into(),
        },
        Authority::RunWake {
            id: "wake".into(),
            scope_id: "scope".into(),
        },
    ] {
        let refused = owner_only(&authority, |id| anyhow!("refused {id}")).unwrap_err();
        assert!(refused.to_string().starts_with("refused "));
    }
}

#[test]
fn a_replace_writes_an_owner_only_file_and_leaves_no_temporary_behind() {
    let scratch = scratch();
    std::fs::write(scratch.0.join("state.json"), "old").unwrap();
    replace(&scratch.0, "state.json", b"new").unwrap();
    assert_eq!(std::fs::read(scratch.0.join("state.json")).unwrap(), b"new");
    assert_eq!(names(&scratch.0), ["state.json"]);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(scratch.0.join("state.json"))
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o600);
    }
    std::fs::create_dir(scratch.0.join("folder.json")).unwrap();
    assert!(matches!(
        replace(&scratch.0, "folder.json", b"x"),
        Err(Refusal::Unwritable(_))
    ));
    assert_eq!(names(&scratch.0), ["folder.json", "state.json"]);
}

#[test]
fn a_replace_into_a_folder_that_now_resolves_elsewhere_is_refused_before_the_rename() {
    let scratch = scratch();
    let elsewhere = scratch.0.join("elsewhere");
    std::fs::create_dir(&elsewhere).unwrap();
    std::fs::write(elsewhere.join("state.json"), "outside").unwrap();
    let checked = scratch.0.join("checked");
    assert!(link_directory(&elsewhere, &checked));
    assert!(matches!(
        replace(&checked, "state.json", b"inside"),
        Err(Refusal::Linked)
    ));
    assert_eq!(names(&elsewhere), ["state.json"]);
    assert_eq!(
        std::fs::read(elsewhere.join("state.json")).unwrap(),
        b"outside"
    );
}

#[test]
fn a_walk_creates_plain_levels_and_refuses_links_files_and_missing_levels() {
    let scratch = scratch();
    let created = walk(&scratch.0, &[".nesvo", "notes"], true).unwrap();
    assert_eq!(created, scratch.0.join(".nesvo").join("notes"));
    assert!(created.is_dir());
    assert_eq!(
        walk(&scratch.0, &[".nesvo", "notes"], false).unwrap(),
        created
    );
    assert!(matches!(
        walk(&scratch.0, &[".nesvo", "absent"], false),
        Err(Refusal::Missing)
    ));
    std::fs::write(scratch.0.join("plain"), "file").unwrap();
    assert!(matches!(
        walk(&scratch.0, &["plain", "notes"], true),
        Err(Refusal::NotDirectory)
    ));
    let elsewhere = scratch.0.join("elsewhere");
    std::fs::create_dir(&elsewhere).unwrap();
    assert!(link_directory(&elsewhere, &scratch.0.join("linked")));
    assert!(matches!(
        walk(&scratch.0, &["linked", "notes"], true),
        Err(Refusal::Linked)
    ));
    assert!(!elsewhere.join("notes").exists());
}

#[test]
fn a_plain_open_truncates_a_plain_file_and_refuses_a_second_name_for_it() {
    let scratch = scratch();
    let path = scratch.0.join("run.log");
    std::fs::write(&path, "an older and much longer log").unwrap();
    open_plain(&path).unwrap().write_all(b"fresh").unwrap();
    assert_eq!(std::fs::read(&path).unwrap(), b"fresh");
    let victim = scratch.0.join("victim.txt");
    std::fs::write(&victim, "keep").unwrap();
    std::fs::hard_link(&victim, scratch.0.join("linked.log")).unwrap();
    let refused = open_plain(&scratch.0.join("linked.log")).unwrap_err();
    assert_eq!(refused.kind(), io::ErrorKind::PermissionDenied);
    assert_eq!(std::fs::read(&victim).unwrap(), b"keep");
}

#[test]
fn a_registry_update_swaps_memory_only_after_the_file_is_replaced() {
    let scratch = scratch();
    let registry = counter(&scratch.0).unwrap();
    registry
        .update(|counter| {
            counter.values.push(1);
            Ok(())
        })
        .unwrap();
    assert!(
        registry
            .update(|counter| {
                counter.values.push(2);
                Err::<(), _>(anyhow!("refused change"))
            })
            .is_err()
    );
    let target = scratch.0.join("counter.json");
    std::fs::remove_file(&target).unwrap();
    std::fs::create_dir(&target).unwrap();
    assert!(
        registry
            .update(|counter| {
                counter.values.push(3);
                Ok(())
            })
            .is_err()
    );
    assert_eq!(
        registry.read(|counter| counter.values.clone()).unwrap(),
        [1]
    );
    std::fs::remove_dir(&target).unwrap();
    registry
        .update(|counter| {
            counter.values.push(4);
            Ok(())
        })
        .unwrap();
    assert_eq!(names(&scratch.0), ["counter.json"]);
    let reopened = counter(&scratch.0).unwrap();
    assert_eq!(
        reopened.read(|counter| counter.values.clone()).unwrap(),
        [1, 4]
    );
    std::fs::write(&target, r#"{"version":2,"values":[]}"#).unwrap();
    assert!(counter(&scratch.0).is_err());
    std::fs::write(&target, vec![b' '; 1025]).unwrap();
    assert!(counter(&scratch.0).is_err());
}

#[tokio::test]
async fn an_async_registry_update_refuses_a_concurrent_sync_writer_and_persists_once() {
    let scratch = scratch();
    let registry = counter(&scratch.0).unwrap();
    registry
        .update_async(|counter| {
            assert!(
                registry
                    .update(|counter| {
                        counter.values.push(9);
                        Ok(())
                    })
                    .is_err()
            );
            counter.values.push(1);
            Ok(())
        })
        .await
        .unwrap();
    assert_eq!(
        registry.read(|counter| counter.values.clone()).unwrap(),
        [1]
    );
    let reopened = counter(&scratch.0).unwrap();
    assert_eq!(
        reopened.read(|counter| counter.values.clone()).unwrap(),
        [1]
    );
}
