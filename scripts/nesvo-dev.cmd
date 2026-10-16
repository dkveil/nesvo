@echo off
setlocal
set "REPO_ROOT=%~dp0.."
for %%I in ("%REPO_ROOT%") do set "REPO_ROOT=%%~fI"
if not defined NESVO_DEV_PAIRING set "NESVO_DEV_PAIRING=%REPO_ROOT%\host\.local\pairing.json"

where cargo >nul 2>&1
if errorlevel 1 (
  echo Rust Cargo is not on PATH. Install Rust before running nesvo-dev. 1>&2
  exit /b 1
)
if not exist "%NESVO_DEV_PAIRING%" (
  echo Pairing file not found: "%NESVO_DEV_PAIRING%" 1>&2
  echo Start nesvo-host or set NESVO_DEV_PAIRING to its pairing.json. 1>&2
  exit /b 1
)

pushd "%REPO_ROOT%" || exit /b 1
echo Building nesvo from the current development source...
cargo build --package nesvo --locked --target-dir target\nesvo-dev
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
popd
"%RUN_EXE%" --pairing "%NESVO_DEV_PAIRING%" %*
set "EXIT_CODE=%ERRORLEVEL%"
del /Q "%RUN_EXE%" >nul 2>&1
endlocal & exit /b %EXIT_CODE%
