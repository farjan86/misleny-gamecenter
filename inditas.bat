@echo off
chcp 65001 >nul
title TANK MISLENY
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo A Node.js nincs telepítve, vagy nincs a PATH-ban.
  echo Letöltés: https://nodejs.org/
  pause
  exit /b 1
)

if not exist "node_modules\" (
  echo Függőségek telepítése, ez első alkalommal eltarthat egy-két percig...
  call npm install
  if errorlevel 1 (
    echo A függőségek telepítése nem sikerült.
    pause
    exit /b 1
  )
)

rem Az optimalizált, éles változat készül el és indul - ez gyorsabban tölt be
rem és kevesebb erőforrást kér, mint a fejlesztői mód.
echo A játék előkészítése, néhány másodperc...
call npx vite build --logLevel warn
if errorlevel 1 (
  echo A játék összeállítása nem sikerült.
  pause
  exit /b 1
)

echo.
echo TANK MISLENY indul, a böngésző magától megnyílik.
echo Leállítás: Ctrl+C, vagy zárd be ezt az ablakot.
echo.
call npx vite preview --open

pause
