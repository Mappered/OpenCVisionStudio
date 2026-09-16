@echo off
setlocal EnableExtensions
cd /d "%~dp0"

rem The frame server activates the media source inside its own service
rem process, which cannot read HKCU: the registration has to be machine
rem wide, and that needs elevation.
net session >nul 2>&1
if errorlevel 1 (
  echo Requesting elevation: the media source is registered in HKLM.
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)

echo [1/3] registering the media source
vcam-register.exe register "%~dp0vcamsource.dll"

echo.
echo [2/3] creating the virtual camera, enumerating it and reading a frame
vcam-read.exe > "%~dp0vcam-read-output.txt" 2>&1
type "%~dp0vcam-read-output.txt"

echo.
echo [3/3] what the frame server did with the media source
if exist "%~dp0vcamsource.dll.log" (
  type "%~dp0vcamsource.dll.log"
) else (
  echo (no trace: the media source was never loaded)
)

echo.
echo vcam-read-output.txt and vcamsource.dll.log are both in this folder.
echo For a live camera feed instead of this test, run run-live.cmd.
pause
