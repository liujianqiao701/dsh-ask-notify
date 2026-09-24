@echo off
rem ============================================================================
rem  DSH restart + verify  (dsh-ask-notify)
rem
rem  WHAT IT DOES
rem    1) finds the DSH web server by the port it listens on
rem    2) stops it (only that one process tree - no other node app is touched)
rem    3) starts "npx --yes @deepseek-ai/dsh web" in a new window
rem    4) waits until the port answers again, then opens the GUI in the browser
rem    5) prints the two verification steps you must do in the browser
rem
rem  USAGE
rem    double-click it            (uses port 3080)
rem    重启并验证.cmd 3081        (a different port)
rem    重启并验证.cmd 3080 --host 0.0.0.0     (extra flags are passed through)
rem
rem  If you normally start DSH with extra flags and forget them here, DSH still
rem  starts - it just may lose LAN access etc. Just close it and start it your
rem  usual way instead.
rem ============================================================================
setlocal
title DSH restart + verify

set "PORT=%~1"
if "%PORT%"=="" set "PORT=3080"
echo %PORT%| findstr /R "^[0-9][0-9]*$" >nul || set "PORT=3080"

shift
set "EXTRA="
:collect
if "%~1"=="" goto collectdone
set "EXTRA=%EXTRA% %1"
shift
goto collect

:collectdone
echo ============================================================
echo   DSH restart + verify        port: %PORT%
echo ============================================================
echo.

echo [1/4] stopping the DSH web server ...
set "PID="
for /f "tokens=5" %%p in ('netstat -ano ^| findstr /R /C:":%PORT% " ^| findstr /C:"LISTENING"') do set "PID=%%p"

if not defined PID goto nostop
echo       port %PORT% is held by PID %PID%
rem safety gate: only ever kill a node.exe, never some other app that happens
rem to hold the same port
tasklist /FI "PID eq %PID%" | findstr /I "node.exe" >nul
if errorlevel 1 goto notnode
taskkill /F /T /PID %PID% >nul 2>&1
if errorlevel 1 goto killfail
echo       stopped.
goto startit

:notnode
echo.
echo       PID %PID% is NOT node.exe, so this is not DSH - refusing to touch it.
echo       Something else is using port %PORT%. Close it yourself, or run this
echo       file with the port DSH actually uses.
echo.
pause
exit /b 1

:nostop
echo       nothing is listening on port %PORT%, so DSH is not running right now.

:startit
echo.
echo [2/4] starting DSH in a new window (do not close that window) ...
start "DSH web - do not close" cmd /k npx --yes @deepseek-ai/dsh web%EXTRA%

echo       waiting for port %PORT% to come back up (up to 90 seconds) ...
set /a TRIES=0

:wait
rem ping is used as a 3-second sleep on purpose: "timeout" fails instantly when
rem stdin is not a console, which would make this loop spin and misreport.
ping -n 4 127.0.0.1 >nul
set /a TRIES+=1
set "UP="
for /f "tokens=5" %%p in ('netstat -ano ^| findstr /R /C:":%PORT% " ^| findstr /C:"LISTENING"') do set "UP=%%p"
if defined UP goto ready
if %TRIES% GEQ 30 goto slow
goto wait

:slow
echo.
echo       port %PORT% is STILL not listening after 90 seconds.
echo       Look at the window titled "DSH web - do not close" - it probably
echo       shows an error. Do NOT reinstall anything: send that window's text
echo       to the author together with the report of check-ask-notify.cmd.
echo.
pause
exit /b 1

:ready
echo       DSH is listening again.
echo.
echo [3/4] opening the GUI in your browser ...
start "" "http://127.0.0.1:%PORT%/"
echo.
echo [4/4] DO THIS IN THE BROWSER (the check that actually proves it):
echo.
echo         a) press   Ctrl+F5      (hard refresh)
echo         b) press   F12   then click the "Console" tab
echo         c) TYPE this line by hand - do NOT paste it - then press Enter:
echo.
echo                __dshAskNotify.selftest()
echo.
echo      - a demo card in the bottom-right corner for 12 seconds = IT WORKS
echo      - the console prints "undefined"                       = it does NOT
echo.
echo      If it still does not work: STOP restarting. Run check-ask-notify.cmd
echo      and send back the report file - that one tells the real reason.
echo.
pause
exit /b 0

:killfail
echo.
echo       could NOT stop PID %PID%.
echo       Close the window that runs DSH manually (Ctrl+C in it, or close it),
echo       then run this file again.
echo.
pause
exit /b 1
