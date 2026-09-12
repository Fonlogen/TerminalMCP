@echo off
rem Start TerminalMCP as a remote HTTP server on Windows.
rem
rem This script binds 0.0.0.0 on purpose: it exists for remote access. There is
rem NO authentication - anyone who can reach the port gets a shell on this box.
rem For a local-only server use  start.cmd --http  instead (binds 127.0.0.1).
rem
rem Override with env vars or extra arguments:
rem   set PORT=9000 && start-http.cmd
rem   start-http.cmd --host 127.0.0.1 --shell gitbash
setlocal

if "%HOST%"=="" set HOST=0.0.0.0
if "%PORT%"=="" set PORT=8787

where node >nul 2>nul
if errorlevel 1 (
  echo TerminalMCP needs Node.js ^>= 18 on PATH. Install it from https://nodejs.org 1>&2
  exit /b 1
)

for /f "delims=" %%v in ('node -p "process.versions.node.split('.')[0]"') do set NODE_MAJOR=%%v
if %NODE_MAJOR% LSS 18 (
  echo Node version is too old; TerminalMCP needs ^>= 18. 1>&2
  exit /b 1
)

node "%~dp0bin\terminalmcp.js" --http --host %HOST% --port %PORT% %*
exit /b %ERRORLEVEL%
