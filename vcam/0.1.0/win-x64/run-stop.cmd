@echo off
setlocal EnableExtensions
cd /d "%~dp0"

rem Stopping the publisher and removing the registration both need the
rem elevation the publisher was started with.
net session >nul 2>&1
if errorlevel 1 (
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)

echo stopping the publisher
taskkill /IM vcam-publisher.exe /F >nul 2>&1
echo unregistering the media source
vcam-register.exe unregister
pause
