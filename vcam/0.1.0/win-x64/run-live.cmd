@echo off
setlocal EnableExtensions
cd /d "%~dp0"

rem The frame server reads the media source registration from HKLM, so
rem this has to run elevated.
net session >nul 2>&1
if errorlevel 1 (
  echo Requesting elevation: the media source is registered in HKLM.
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)

echo [1/3] registering the media source
vcam-register.exe register "%~dp0vcamsource.dll" || goto :failed

echo.
echo [2/3] cameras Aravis can see
vcam-publisher.exe --list

echo.
echo [3/3] publishing frames in a separate window
rem Optional first argument: the camera index from the list above.
set VCAM_DEVICE=%~1
powershell -NoProfile -Command "Start-Process -FilePath '%~dp0vcam-publisher.exe' -WorkingDirectory '%~dp0' -ArgumentList '--aravis','--run',$env:VCAM_DEVICE"
if errorlevel 1 goto :failed

echo.
echo Now open the Windows Camera app and pick "OpenCVisionStudio Virtual Camera".
echo The publisher window shows the frame rate; close it or run run-stop.cmd
echo when you are done.
exit /b 0

:failed
echo something went wrong - see the messages above.
pause
exit /b 1
