@echo off
rem dsh-ask-notify diagnostic launcher - just double-click this file.
rem Read-only: it never changes anything.
rem When it finishes, the report file is created next to this script and opened
rem in Explorer, ready to be sent back to the author.
setlocal
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0check-ask-notify.ps1" %*
echo.
echo ---- end ----
if exist "%~dp0dsh-ask-notify-report.txt" (
  echo The report file is: %~dp0dsh-ask-notify-report.txt
  echo Send THAT FILE back to the author. Press any key to open its folder.
  pause > nul
  start "" explorer /select,"%~dp0dsh-ask-notify-report.txt"
) else (
  echo No report file was produced - copy the text above instead.
  pause
)
exit /b 0
