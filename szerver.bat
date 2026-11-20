@echo off
chcp 65001 >nul
title TANK MISLENY - szerver
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
rem A verziószám magától nő, ha a játék forrása megváltozott az előző összeállítás óta.
call node scripts/version.mjs
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

rem Az alagút neve az alagut.txt első sorában állhat (lásd docs\multiplayer.md).
rem Ha nincs ilyen fájl, ideiglenes alagút indul, amely minden indításkor más címet ad.
set "TUNNEL="
if exist "alagut.txt" set /p TUNNEL=<alagut.txt

where cloudflared >nul 2>nul
if errorlevel 1 (
  echo.
  echo A cloudflared nincs telepítve, ezért a szerver csak a helyi hálózatról érhető el.
  echo Telepítés: winget install --id Cloudflare.cloudflared
  echo.
) else (
  if defined TUNNEL (
    echo Az alagút indul a saját címeden: %TUNNEL%
    start "TANK MISLENY - alagút" cmd /k cloudflared tunnel run --url http://localhost:8787 %TUNNEL%
  ) else (
    echo Ideiglenes alagút indul: a nyilvános címet a másik ablak írja ki ^(trycloudflare.com^).
    start "TANK MISLENY - alagút" cmd /k cloudflared tunnel --url http://localhost:8787
  )
)

echo.
echo A játékszerver fut. Helyben: http://localhost:8787/
echo Amíg ez az ablak nyitva van, a játék elérhető. Leállítás: Ctrl+C.
echo.
node dist-server\server.mjs

pause
