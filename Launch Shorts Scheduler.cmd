@echo off
cd /d "%~dp0"
if exist "%~dp0release\ShortsScheduler\ShortsScheduler.exe" (
  start "" "%~dp0release\ShortsScheduler\ShortsScheduler.exe"
) else if exist "%~dp0node_modules\electron\dist\electron.exe" (
  start "" "%~dp0node_modules\electron\dist\electron.exe" "%~dp0"
) else (
  echo Open START HERE.txt for setup. Install Node.js, then run npm ci and npm start.
  pause
)
