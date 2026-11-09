@echo off
rem 本机 PowerShell 默认禁止运行 .ps1，这一层只是用 Bypass 包一下
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-policy.ps1" %*
