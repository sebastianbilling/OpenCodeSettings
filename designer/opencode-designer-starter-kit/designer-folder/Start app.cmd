@echo off
title Design app
cd /d "%~dp0.."
set DESIGNER_WINDOW=1
node .designer\app.mjs run
if "%errorlevel%"=="3" goto running
echo.
echo The app has stopped. You can close this window.
pause >nul
exit /b
:running
echo This window closes by itself in a few seconds.
timeout /t 6 >nul
