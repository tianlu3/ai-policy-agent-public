@echo off
chcp 65001 >nul 2>&1
setlocal
cd /d "%~dp0"
title AI 政策搜索智能体 · 停止服务

echo.
echo   正在停止 守护进程 + 后端服务 ...
echo.

if not exist ".venv\Scripts\python.exe" goto :nopy
".venv\Scripts\python.exe" "stop_guard.py"
goto :done

:nopy
where python >nul 2>&1
if errorlevel 1 goto :nopyfail
python "stop_guard.py"
goto :done

:nopyfail
echo   [!] 未找到 Python，无法调用停止脚本。
echo       请打开任务管理器，结束 pythonw.exe / python.exe 进程即可。
goto :done

:done
echo.
pause
exit /b 0
