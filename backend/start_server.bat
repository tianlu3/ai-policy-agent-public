@echo off
chcp 65001 >nul 2>&1
setlocal enabledelayedexpansion
cd /d "%~dp0"
title AI 政策搜索智能体 - 本地服务

echo.
echo   ==================================================
echo     AI 政策搜索智能体 · 本地后端
echo     检索链路 + 账号体系(MySQL) · 一键启动
echo   ==================================================
echo.

set "ROOT=%~dp0"
set "VENV=%ROOT%.venv"
set "PY="
set "PYA="
set "PORT=8000"
set "PYTHONUTF8=1"
set "PYTHONIOENCODING=utf-8"
rem 本机若配置了 http_proxy，访问 localhost 会被代理拦截，这里强制直连
set "NO_PROXY=127.0.0.1,localhost"
set "no_proxy=127.0.0.1,localhost"
if not defined TEMP set "TEMP=%ROOT%tmp"
if not exist "%TEMP%" mkdir "%TEMP%" >nul 2>&1
set "DBTXT=%TEMP%\ai_policy_db_status.txt"

rem ---------- [1/5] 定位 Python ----------
if exist "%VENV%\Scripts\python.exe" set "PY=%VENV%\Scripts\python.exe"
if not defined PY if exist "%ROOT%venv\Scripts\python.exe" set "PY=%ROOT%venv\Scripts\python.exe"
if not defined PY (
  for /f "usebackq delims=" %%i in (`where python 2^>nul`) do (
    if not defined PY (
      rem 跳过应用商店占位程序与其它工具的私有环境，只认用户自己的 Python
      set "PTH=%%i"
      if "!PTH:WindowsApps=!"=="!PTH!" if "!PTH:.workbuddy=!"=="!PTH!" set "PY=%%i"
    )
  )
)
if not defined PY (
  for /f "usebackq delims=" %%i in (`where py 2^>nul`) do (
    if not defined PY (
      set "PY=%%i"
      set "PYA=-3"
    )
  )
)
if not defined PY goto :nopy
echo   [1/5] Python      : %PY% %PYA%

rem ---------- [2/5] 依赖 ----------
rem 依赖清单以 requirements.txt 为准（fastapi / uvicorn / pymysql）
"%PY%" %PYA% -c "import fastapi, uvicorn, pymysql" >nul 2>&1
if not errorlevel 1 goto :dep_ok

if not exist "%VENV%\Scripts\python.exe" (
  echo   [2/5] 首次运行，正在创建虚拟环境 .venv ...
  "%PY%" %PYA% -m venv "%VENV%"
  if errorlevel 1 goto :venvfail
  set "PY=%VENV%\Scripts\python.exe"
  set "PYA="
)
echo   [2/5] 正在安装依赖 fastapi / uvicorn / pymysql（首次需要联网，请稍候）...
"%PY%" %PYA% -m pip install --quiet --upgrade pip
"%PY%" %PYA% -m pip install --quiet -r "%ROOT%requirements.txt"
if errorlevel 1 goto :pipfail
"%PY%" %PYA% -c "import fastapi, uvicorn, pymysql" >nul 2>&1
if errorlevel 1 goto :pipfail

:dep_ok
echo   [2/5] 依赖        : 就绪（fastapi / uvicorn / pymysql）

rem ---------- [3/5] MySQL（探测，不阻断启动） ----------
rem 账号与「检索记录」依赖 MySQL；连不上时自动以游客模式继续，检索主链路不受影响。
set "DBC="
set "DBLINE="
if exist "%ROOT%tools\check_db.py" (
  "%PY%" %PYA% "%ROOT%tools\check_db.py" > "%DBTXT%" 2>nul
  set "DBC=!errorlevel!"
  if exist "%DBTXT%" set /p DBLINE=<"%DBTXT%"
  if exist "%DBTXT%" del "%DBTXT%" >nul 2>&1
)
if not defined DBLINE set "DBLINE=未检测（缺少 tools\check_db.py）"
echo   [3/5] MySQL       : !DBLINE!
if "!DBC!"=="0" goto :db_ready
if "!DBC!"=="4" goto :db_ready
echo   [i] 账号与「检索记录」暂不可用；检索 / 简报 / 导出照常（自动以游客模式运行）。
echo   [i] 排查：① 确认 MySQL 已启动 —— 本机服务名通常为 MySQL84（可用 services.msc 查看）
echo   [i]       ② 核对 backend\.env 里的 DB_HOST / DB_PORT / DB_USER / DB_PASSWORD
echo   [i]       ③ 不想装 MySQL 又要账号功能：在 .env 里设 DB_ENABLED=sqlite（内置文件库）
echo   [i]       ④ 完全不需要账号功能时，可在 .env 里设 DB_ENABLED=0 跳过本项
:db_ready

rem ---------- [4/5] 数据 ----------
if not exist "%ROOT%app\data\bootstrap.json" (
  echo   [4/5] 未找到数据文件，正在从 test_date.js 生成 ...
  "%PY%" %PYA% "%ROOT%tools\convert_test_data.py"
  if errorlevel 1 goto :datafail
)
echo   [4/5] 数据        : app\data\bootstrap.json

rem ---------- [5/5] 启动 ----------
rem 端口占用 / 是否已在运行，统一交给 run.py 判断（避免重复启动同一个服务）
echo   [5/5] 正在启动服务 ...
echo.

"%PY%" %PYA% "%ROOT%run.py" --host 127.0.0.1 --port %PORT% --open %*
set "RC=%errorlevel%"

echo.
if "%RC%"=="0" (
  echo   服务已停止。
) else (
  if "%RC%"=="7" (
    echo   本地服务已在运行，页面已在浏览器中打开。
  ) else (
    echo   启动失败（退出码 %RC%），请查看上方提示。
  )
)
echo.
pause
exit /b %RC%

rem ==================== 错误处理 ====================

:nopy
echo.
echo   [x] 未检测到 Python 3。
echo       请先安装 Python 3.10 或更高版本：https://www.python.org/downloads/
echo       安装时务必勾选 "Add python.exe to PATH"，然后重新双击本文件。
goto :fail

:venvfail
echo.
echo   [x] 创建虚拟环境失败。请在命令行执行 python -V 确认 Python 是否可用。
goto :fail

:pipfail
echo.
echo   [x] 依赖安装失败。请检查网络后重新双击本文件，或手动执行：
echo       pip install -r requirements.txt
goto :fail

:datafail
echo.
echo   [x] 生成数据失败。该步骤需要本机安装 Node.js，
echo       并确认 ..\gui-prototype\test_date.js 存在。
goto :fail

:fail
echo.
pause
exit /b 1
