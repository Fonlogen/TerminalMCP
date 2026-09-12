@echo off
rem Start TerminalMCP on Windows (cmd.exe / PowerShell / MCP client).
rem Extra arguments pass straight through, e.g.  start.cmd --shell gitbash
setlocal

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

node "%~dp0bin\terminalmcp.js" %*
exit /b %ERRORLEVEL%
