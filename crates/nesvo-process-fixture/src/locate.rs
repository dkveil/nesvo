use std::{
    fs::Metadata,
    path::{Path, PathBuf},
    process::Command,
    sync::OnceLock,
};

const WORKSPACE: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../..");
const DEPS_STEM: &str = "nesvo_process_fixture";
const UPLIFTED_STEM: &str = "nesvo-process-fixture";

pub fn executable() -> &'static Path {
    static EXECUTABLE: OnceLock<PathBuf> = OnceLock::new();
    EXECUTABLE.get_or_init(build)
}

fn build() -> PathBuf {
    let test_binary = std::env::current_exe().expect("test binary path");
    let target = test_binary
        .parent()
        .and_then(Path::parent)
        .expect("test binary lives in <target>/<profile>/deps")
        .join("process-fixture-target");
    let cargo = std::env::var_os("CARGO").unwrap_or_else(|| env!("CARGO").into());
    let output = Command::new(cargo)
        .current_dir(WORKSPACE)
        .args([
            "build",
            "--quiet",
            "--locked",
            "--package",
            "nesvo-process-fixture",
        ])
        .arg("--target-dir")
        .arg(&target)
        .output()
        .expect("cargo builds the process fixture");
    assert!(
        output.status.success(),
        "process fixture build failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    compiled_artifact(&target.join("debug"))
}

fn compiled_artifact(profile: &Path) -> PathBuf {
    let deps = profile.join("deps");
    newest_hashed_artifact(&deps)
        .or_else(|| Some(deps.join(executable_name(DEPS_STEM))).filter(|path| is_executable(path)))
        .unwrap_or_else(|| profile.join(executable_name(UPLIFTED_STEM)))
}

fn newest_hashed_artifact(deps: &Path) -> Option<PathBuf> {
    std::fs::read_dir(deps)
        .ok()?
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| is_hashed_artifact(path) && is_executable(path))
        .max_by_key(|path| {
            path.metadata()
                .and_then(|metadata| metadata.modified())
                .ok()
        })
}

fn is_hashed_artifact(path: &Path) -> bool {
    path.file_name()
        .and_then(|name| name.to_str())
        .and_then(|name| name.strip_prefix(DEPS_STEM))
        .and_then(|rest| rest.strip_prefix('-'))
        .and_then(|rest| rest.strip_suffix(std::env::consts::EXE_SUFFIX))
        .is_some_and(|hash| !hash.is_empty() && hash.chars().all(|c| c.is_ascii_alphanumeric()))
}

fn executable_name(stem: &str) -> String {
    format!("{stem}{}", std::env::consts::EXE_SUFFIX)
}

fn is_executable(path: &Path) -> bool {
    path.metadata()
        .is_ok_and(|metadata| metadata.is_file() && has_execute_permission(&metadata))
}

#[cfg(unix)]
fn has_execute_permission(metadata: &Metadata) -> bool {
    use std::os::unix::fs::PermissionsExt;
    metadata.permissions().mode() & 0o111 != 0
}

#[cfg(not(unix))]
fn has_execute_permission(_metadata: &Metadata) -> bool {
    true
}
