@echo off
setlocal
set "REPO_ROOT=%~dp0.."
for %%I in ("%REPO_ROOT%") do set "REPO_ROOT=%%~fI"
if not defined NESVO_DEV_PAIRING set "NESVO_DEV_PAIRING=%REPO_ROOT%\host\.local\dev\pairing.json"

where cargo >nul 2>&1
if errorlevel 1 (
  echo Rust Cargo is not on PATH. Install Rust before running nesvo-dev. 1>&2
  exit /b 1
)
pushd "%REPO_ROOT%" || exit /b 1
echo Building nesvo and nesvo-host from the current development source...
cargo build --package nesvo --package nesvo-host --locked --target-dir target\nesvo-dev
if errorlevel 1 (
  popd
  exit /b 1
)
set "RUN_EXE=%TEMP%\nesvo-dev-%RANDOM%-%RANDOM%.exe"
copy /Y "target\nesvo-dev\debug\nesvo.exe" "%RUN_EXE%" >nul
if errorlevel 1 (
  popd
  echo Could not prepare the latest nesvo executable. 1>&2
  exit /b 1
)
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%REPO_ROOT%\scripts\ensure-dev-host.ps1" -PairingPath "%NESVO_DEV_PAIRING%" -ClientExe "%RUN_EXE%" -HostExe "%REPO_ROOT%\target\nesvo-dev\debug\nesvo-host.exe" -Workspace "%REPO_ROOT%"
if errorlevel 1 (
  popd
  del /Q "%RUN_EXE%" >nul 2>&1
  exit /b 1
)
popd
"%RUN_EXE%" --pairing "%NESVO_DEV_PAIRING%" %*
set "EXIT_CODE=%ERRORLEVEL%"
del /Q "%RUN_EXE%" >nul 2>&1
endlocal & exit /b %EXIT_CODE%
