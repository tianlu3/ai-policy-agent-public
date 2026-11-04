@echo off
chcp 65001 >nul 2>&1
setlocal
cd /d "%~dp0"
title AI 政策搜索智能体 · 守护启动

set "PYTHONUTF8=1"
set "PYTHONIOENCODING=utf-8"
set "NO_PROXY=127.0.0.1,localhost"
set "no_proxy=127.0.0.1,localhost"

echo.
echo   ==================================================
echo     AI 政策搜索智能体 · 演示守护启动
echo     无窗口运行 · 进程意外退出会 2 秒内自动重启
echo   ==================================================
echo.

if not exist ".venv\Scripts\pythonw.exe" goto :noenv
if not exist "run_guard.py" goto :nofile

rem 已在运行就不重复拉起（run_guard.py 内部还会再判一次单实例锁）
start "" ".venv\Scripts\pythonw.exe" "run_guard.py"

echo   正在等待服务就绪（最多 40 秒）...
powershell -NoProfile -ExecutionPolicy Bypass -Command "for($i=0;$i -lt 40;$i++){try{$c=New-Object Net.Sockets.TcpClient;$c.Connect('127.0.0.1',8000);$c.Close();Write-Host '   [OK] 服务已就绪 -> http://127.0.0.1:8000/';exit 0}catch{Start-Sleep -Milliseconds 500}};Write-Host '   [!] 40 秒仍未就绪，请查看本目录 _run8000_live.log';exit 1"
if errorlevel 1 goto :fail

start "" "http://127.0.0.1:8000/"
echo.
echo   浏览器已打开。演示结束后若要彻底关闭服务，双击同目录的「停止服务.bat」。
echo   本窗口可以直接关掉，不会影响后台服务。
echo.
timeout /t 4 >nul
exit /b 0

:noenv
echo   [x] 未找到 .venv（虚拟环境）
echo       请先双击同目录的 start_server.bat 完成首次安装（需联网装依赖），
echo       装好之后再双击本文件即可。
echo.
pause
exit /b 1

:nofile
echo   [x] 未找到 run_guard.py，请确认本目录文件完整。
echo.
pause
exit /b 1

:fail
echo.
echo   服务没能起来。常见原因：
echo     - 8000 端口被别的程序占用（先双击「停止服务.bat」再重试）
echo     - 首次使用还没装依赖（先跑一次 start_server.bat）
echo     - 数据库未启动（演示包默认用 SQLite，通常不需要 MySQL）
echo.
pause
exit /b 1
