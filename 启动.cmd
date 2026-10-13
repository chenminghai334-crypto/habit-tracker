@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"

set "HT_NODE="
where node >nul 2>nul && set "HT_NODE=node"

if not defined HT_NODE (
  for %%D in (
    "%LOCALAPPDATA%\Programs\nodejs\node.exe"
    "%ProgramFiles%\nodejs\node.exe"
    "%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
  ) do (
    if not defined HT_NODE if exist "%%~D" set "HT_NODE=%%~D"
  )
)

if not defined HT_NODE (
  echo.
  echo   没有找到 Node.js。
  echo   请先安装（免费）： https://nodejs.org/  安装后重新双击本文件。
  echo.
  pause
  exit /b 1
)

echo 正在启动 习惯打卡 ...
start "习惯打卡" /min "%HT_NODE%" serve.js
rem 用 ping 代替 timeout 等待，timeout 在没有控制台输入时会直接报错退出
ping -n 3 127.0.0.1 >nul
start "" "http://localhost:8080/"

echo.
echo   浏览器已经打开 http://localhost:8080/
echo   关闭那个最小化的窗口即可停止服务。
echo.
ping -n 4 127.0.0.1 >nul
