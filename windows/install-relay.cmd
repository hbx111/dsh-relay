@echo off
setlocal
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-relay.ps1" %*
echo.
pause
