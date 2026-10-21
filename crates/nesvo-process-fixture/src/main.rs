use std::{
    io::{Read, Write},
    path::Path,
    process::ExitCode,
    time::{Duration, Instant},
};

const RELEASE_DEADLINE: Duration = Duration::from_secs(30);

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let result = match args
        .iter()
        .map(String::as_str)
        .collect::<Vec<_>>()
        .as_slice()
    {
        ["hold"] => hold(),
        ["emit", bytes] => emit(bytes),
        ["echo", code] => echo(code, ""),
        ["echo", code, prefix] => echo(code, prefix),
        ["gate", release, program, rest @ ..] => gate(Path::new(release), program, rest),
        _ => Err(format!("unsupported fixture arguments: {args:?}")),
    };
    result.unwrap_or_else(|error| {
        eprintln!("nesvo-process-fixture: {error}");
        ExitCode::from(101)
    })
}

fn hold() -> Result<ExitCode, String> {
    std::io::copy(&mut std::io::stdin(), &mut std::io::sink()).map_err(|e| e.to_string())?;
    Ok(ExitCode::SUCCESS)
}

fn emit(bytes: &str) -> Result<ExitCode, String> {
    write_stdout(&decode_hex(bytes)?)?;
    hold()
}

fn echo(code: &str, prefix: &str) -> Result<ExitCode, String> {
    let code: u8 = code
        .parse()
        .map_err(|_| format!("invalid exit code {code}"))?;
    let mut input = Vec::new();
    std::io::stdin()
        .read_to_end(&mut input)
        .map_err(|e| e.to_string())?;
    let mut output = decode_hex(prefix)?;
    output.extend_from_slice(&input);
    write_stdout(&output)?;
    Ok(ExitCode::from(code))
}

fn gate(release: &Path, program: &str, args: &[&str]) -> Result<ExitCode, String> {
    let started = Instant::now();
    while !release.exists() {
        if started.elapsed() >= RELEASE_DEADLINE {
            return Err(format!("{} was never released", release.display()));
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    let mut command = std::process::Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        for arg in args {
            command.raw_arg(arg);
        }
    }
    #[cfg(not(windows))]
    command.args(args);
    let status = command.status().map_err(|e| e.to_string())?;
    let code = status.code().and_then(|code| u8::try_from(code).ok());
    Ok(code.map_or(ExitCode::FAILURE, ExitCode::from))
}

fn write_stdout(bytes: &[u8]) -> Result<(), String> {
    let mut stdout = std::io::stdout().lock();
    stdout.write_all(bytes).map_err(|e| e.to_string())?;
    stdout.flush().map_err(|e| e.to_string())
}

fn decode_hex(text: &str) -> Result<Vec<u8>, String> {
    if !text.len().is_multiple_of(2) {
        return Err(format!("odd hex length {}", text.len()));
    }
    text.as_bytes()
        .chunks(2)
        .map(|pair| {
            std::str::from_utf8(pair)
                .ok()
                .and_then(|pair| u8::from_str_radix(pair, 16).ok())
                .ok_or_else(|| format!("invalid hex {text}"))
        })
        .collect()
}
