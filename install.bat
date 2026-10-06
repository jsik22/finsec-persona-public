@echo off
rem finsec-persona - Windows installer launcher.
rem Usage:  install.bat <extension id> [-TrustCert] [-Force]
rem         install.bat -Uninstall
rem All arguments are forwarded to install.ps1.

setlocal
chcp 65001 >nul 2>&1

set "PS1=%~dp0install.ps1"
if not exist "%PS1%" (
  echo [ERROR] install.ps1 not found next to install.bat
  pause
  exit /b 1
)

powershell.exe -NoProfile -NoLogo -ExecutionPolicy Bypass -File "%PS1%" %*
set "RC=%ERRORLEVEL%"

rem Double-clicked (no args) or failed: keep the window open so the message is readable.
if not "%RC%"=="0" goto :hold
if "%~1"=="" goto :hold
goto :done

:hold
pause

:done
endlocal & exit /b %RC%
