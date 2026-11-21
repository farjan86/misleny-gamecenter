@echo off
chcp 65001 >nul
title TANK MISLENY - felhő frissítése
cd /d "%~dp0"

rem A játék új változatának feltöltése a felhős gépre (Oracle). A gép címe a felho.txt-ben van.
rem A fiókokhoz, a nyitott játékokhoz és a statisztikához nem nyúl. Lásd docs\felho.md.
rem Ha a deploy\tank.service változott, így kell futtatni: node scripts\deploy.mjs --setup
node scripts\deploy.mjs
echo.
pause
