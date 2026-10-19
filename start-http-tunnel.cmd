@echo off
rem Start TerminalMCP on HTTP and open a Cloudflare quick tunnel to it, so the
rem server can be reached from outside this network - no port forwarding, no
rem router, no account. Every tool group is enabled.
rem
rem   READ THIS BEFORE USING IT
rem
rem   The tunnel gives out a public https://<random>.trycloudflare.com URL and
rem   there is NO authentication. Anyone who has that URL has a full shell on
rem   this machine. The hostname is random, but random is not secret: it goes
rem   wherever you paste it, and a paste into the wrong window is enough.
rem
rem   Close this window when you are finished. The URL dies with it, and the
rem   next run gets a different one.
rem
rem Needs cloudflared on PATH:
rem   winget install --id Cloudflare.cloudflared
rem   or: choco install cloudflared
rem
rem The server binds 127.0.0.1 here on purpose: cloudflared reaches it locally,
rem so the port does not also need to be open on the local network.
rem
rem Override with env vars or extra arguments:
rem   set PORT=9000 && start-http-tunnel.cmd
rem   start-http-tunnel.cmd --tools web --plugin fivem
rem   start-http-tunnel.cmd --cwd D:\Server\FiveM\resources
setlocal

if "%PORT%"=="" set PORT=8787
if "%TOOLS%"=="" set TOOLS=all

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

where cloudflared >nul 2>nul
if errorlevel 1 (
  echo.
  echo cloudflared was not found on PATH. The server will start, but without a
  echo tunnel it is only reachable on this machine.
  echo   winget install --id Cloudflare.cloudflared
  echo.
)

rem --tools all is every group, which is a lot of schema. Some MCP clients cap
rem how much they accept and drop the rest without saying so; if a tool goes
rem missing in your client, trim it - start-http-tunnel.cmd --tools web
node "%~dp0bin\terminalmcp.js" --http --port %PORT% --tunnel --tools %TOOLS% %*
exit /b %ERRORLEVEL%
