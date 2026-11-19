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

echo A játék és a szerver előkészítése, néhány másodperc...
call npx vite build --logLevel warn
if errorlevel 1 (
  echo A játék összeállítása nem sikerült.
  pause
  exit /b 1
)
call npm run --silent server:build
if errorlevel 1 (
  echo A szerver összeállítása nem sikerült.
  pause
  exit /b 1
)

echo.
echo TANK MISLENY indul ezen a gépen: http://localhost:8787/
echo A böngésző magától megnyílik. Ugyanezen a hálózaton lévő gépek a
echo gép IP-címén érik el, pl. http://192.168.1.20:8787/
echo Leállítás: Ctrl+C, vagy zárd be ezt az ablakot.
echo.
start "" "http://localhost:8787/"
node dist-server\server.mjs

pause
