@echo off
REM Ticket Dashboard — config lives in .env (same folder).
REM server.mjs loads .env automatically.
if not exist "%~dp0.env" (
  echo [.env missing] Create a .env file next to server.mjs first.
  pause
  exit /b 1
)
echo Starting Ticket Dashboard (config from .env) ...
node "%~dp0server.mjs"
pause
