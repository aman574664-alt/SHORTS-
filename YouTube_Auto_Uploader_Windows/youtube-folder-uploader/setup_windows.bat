@echo off
cd /d "%~dp0"
echo Installing Python libraries...
py -3 -m pip install --upgrade -r requirements.txt
if errorlevel 1 (
  echo.
  echo Setup failed. Ensure Python 3.10+ is installed from python.org.
) else (
  echo.
  echo Setup complete. Next, add client_secret.json and run start_uploader.bat.
)
pause
