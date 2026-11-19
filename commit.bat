@echo off
chcp 65001 >nul
title TANK MISLENY - mentés a GitHubra
cd /d "%~dp0"
setlocal

rem Ide kerül fel a projekt:
set "REMOTE_URL=https://github.com/farjan86/misleny-gamecenter.git"
set "BRANCH=main"

where git >nul 2>nul
if errorlevel 1 (
  echo A Git nincs telepítve, vagy nincs a PATH-ban.
  echo Letöltés: https://git-scm.com/download/win
  pause
  exit /b 1
)

rem Első használat: helyi Git-tároló létrehozása
if not exist ".git\" (
  echo Első használat: a helyi Git-tároló létrehozása...
  git init >nul
  git symbolic-ref HEAD refs/heads/%BRANCH%
)

rem A távoli tároló címe mindig a fent megadott legyen
git remote get-url origin >nul 2>nul
if errorlevel 1 git remote add origin "%REMOTE_URL%"
git remote set-url origin "%REMOTE_URL%"

rem A commithoz név és e-mail-cím kell
set "IDENTITY=1"
git config user.name >nul 2>nul
if errorlevel 1 set "IDENTITY="
git config user.email >nul 2>nul
if errorlevel 1 set "IDENTITY="
if not defined IDENTITY (
  echo A Git még nem tudja, kinek a nevében mentsen. Állítsd be egyszer:
  echo   git config --global user.name "A neved"
  echo   git config --global user.email "az.email@cimed.hu"
  echo Utána indítsd újra ezt a fájlt.
  pause
  exit /b 1
)

rem Minden változás előkészítése; a .gitignore-ban felsoroltak kimaradnak
git add -A
if errorlevel 1 (
  echo Hiba történt a változások előkészítésekor, a mentés nem készült el.
  pause
  exit /b 1
)

set "HASCHANGES=1"
git diff --cached --quiet
if not errorlevel 1 set "HASCHANGES="

if defined HASCHANGES (
  echo.
  echo A mentésre kerülő változások:
  git status --short
  echo.
)
if not defined HASCHANGES (
  echo Nincs új változás a legutóbbi mentés óta. A feltöltést azért megpróbálom,
  echo hátha egy korábbi mentés még nem került fel.
)

rem A mentés üzenete; az idézőjel elrontaná a parancsot, ezért aposztrófra cseréljük
set "MSG="
if defined HASCHANGES set /p "MSG=Mi változott? Enter = automatikus üzenet: "
if not defined MSG set "MSG=Frissítés %DATE% %TIME:~0,5%"
set "MSG=%MSG:"='%"

if defined HASCHANGES git commit -m "%MSG%"
if defined HASCHANGES if errorlevel 1 (
  echo.
  echo Hiba történt, a mentés nem készült el. A fenti üzenet mutatja az okát.
  pause
  exit /b 1
)

git branch -M %BRANCH%
echo.
echo Feltöltés: %REMOTE_URL%
git push -u origin %BRANCH%
if errorlevel 1 (
  echo.
  echo A feltöltés elsőre nem sikerült. Ha a GitHubon újabb változat van, mint ezen
  echo a gépen, előbb azt kell letölteni - megpróbálom...
  git pull --rebase origin %BRANCH%
  if errorlevel 1 (
    git rebase --abort >nul 2>nul
    echo.
    echo A GitHubon lévő változatot nem sikerült automatikusan összefésülni az
    echo ittenivel. A helyi mentésed megvan, semmi nem veszett el.
    echo Lehetséges okok: nincs internetkapcsolat, nincs jogosultságod a tárolóhoz,
    echo vagy a GitHub-tárolóban más tartalom van, amelyet kézzel kell egyeztetni.
    pause
    exit /b 1
  )
  git push -u origin %BRANCH%
  if errorlevel 1 (
    echo.
    echo A feltöltés nem sikerült. A helyi mentésed megvan.
    echo Lehetséges okok: nincs internetkapcsolat, vagy a bejelentkezés a GitHubra
    echo megszakadt, illetve nincs jogosultságod a tárolóhoz.
    pause
    exit /b 1
  )
)

echo.
echo Kész: a változások felkerültek a GitHubra.
pause
