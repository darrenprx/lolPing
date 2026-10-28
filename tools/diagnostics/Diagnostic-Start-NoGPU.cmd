@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Diagnostic-Start.ps1" -DisableGpu
pause
