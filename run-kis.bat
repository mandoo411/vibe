@echo off
cd /d D:\vibe
echo === sync:kis start ===
call npm run sync:kis
echo === sync:kis EXIT CODE %ERRORLEVEL% ===
echo DONE_KIS_SCRIPT_MARKER
pause
