@echo off
setlocal DisableDelayedExpansion
if exist "%~dp0..\..\Nesvo.exe" set "NESVO_INBOX_CLI_RUNTIME=%~dp0..\..\Nesvo.exe"
if not defined NESVO_INBOX_CLI_RUNTIME (
  echo The bundled Nesvo runtime could not be found. 1>&2
  exit /b 3
)
set "ELECTRON_RUN_AS_NODE=1"
"%NESVO_INBOX_CLI_RUNTIME%" "%~dp0cli.mjs" %*
exit /b %ERRORLEVEL%
