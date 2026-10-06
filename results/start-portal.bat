@echo off
rem Double-click wrapper: runs start-portal.ps1 (a .ps1 double-clicked directly
rem would open in Notepad; and default ExecutionPolicy would block it).
rem Optional arg: port, e.g.  start-portal.bat 7801
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-portal.ps1" %*
