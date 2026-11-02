@echo off
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0foxwarmctl.ps1" %*
exit /b %ERRORLEVEL%
