@echo off
setlocal
cd /d "%~dp0"

where npm >nul 2>nul
if errorlevel 1 (
  echo 找不到 npm。請先安裝 Node.js 20 或更新版本。
  pause
  exit /b 1
)

if not exist "node_modules\google-auth-library\package.json" (
  echo 正在安裝必要套件…
  call npm install
  if errorlevel 1 (
    echo 套件安裝失敗，請檢查網路連線。
    pause
    exit /b 1
  )
)

call npm start
pause
