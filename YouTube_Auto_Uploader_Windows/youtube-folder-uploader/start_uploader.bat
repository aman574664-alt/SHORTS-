@echo off
cd /d "%~dp0"
py -3 uploader.py
if errorlevel 1 (
  echo.
  echo The uploader stopped with an error. Check uploader.log.
)
pause
