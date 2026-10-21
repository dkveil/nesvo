use std::{
    path::{Path, PathBuf},
    process::Command,
    sync::OnceLock,
};

const WORKSPACE: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../..");

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
    target.join("debug").join(format!(
        "nesvo-process-fixture{}",
        std::env::consts::EXE_SUFFIX
    ))
}
