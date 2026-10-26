@echo off
setlocal EnableExtensions EnableDelayedExpansion
cd /d "%~dp0"
title Toastcord starten

set "NODE_CMD="
set "NODE_MAJOR="
where node >nul 2>&1
if not errorlevel 1 (
  for /f "delims=" %%V in ('node -p "Number(process.versions.node.split('.')[0])" 2^>nul') do set "NODE_MAJOR=%%V"
  if defined NODE_MAJOR if !NODE_MAJOR! GEQ 20 set "NODE_CMD=node"
)

if not defined NODE_CMD (
  set "NODE_HOME=%LOCALAPPDATA%\Toastcord\runtime"
  set "NODE_EXE=!NODE_HOME!\node-v22.23.4-win-x64\node.exe"
  if not exist "!NODE_EXE!" (
    echo Toastcord bereitet sich beim ersten Start einmalig vor...
    echo Lade die portable Laufzeit direkt von nodejs.org herunter.
    if not exist "!NODE_HOME!" mkdir "!NODE_HOME!"
    powershell -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop'; $dir=Join-Path $env:LOCALAPPDATA 'Toastcord\runtime'; $zip=Join-Path $dir 'node.zip'; $url='https://nodejs.org/dist/v22.23.4/node-v22.23.4-win-x64.zip'; $expected='cbc74b5e0982c9dbb41525fd8fb5dcd32fbee237863f7829072f4639a1ce5f20'; Invoke-WebRequest -Uri $url -OutFile $zip; $actual=(Get-FileHash -Algorithm SHA256 $zip).Hash.ToLower(); if($actual -ne $expected){Remove-Item $zip -Force; throw 'Download-Pruefung fehlgeschlagen'}; Expand-Archive -Path $zip -DestinationPath $dir -Force; Remove-Item $zip -Force"
    if errorlevel 1 goto download_failed
  )
  set "NODE_CMD=!NODE_EXE!"
)

set "PORT=3000"
:choose_port
netstat -ano | findstr /R /C:":%PORT% .*LISTENING" >nul
if not errorlevel 1 (
  set /a PORT+=1
  if !PORT! LEQ 3010 goto choose_port
  goto no_free_port
)
set "HOST=127.0.0.1"
set "TOASTCORD_LOCAL_MODE=true"
set "TOASTCORD_DATA_DIR=%~dp0data"
if not exist "data" mkdir "data"

echo.
echo Toastcord startet auf Port %PORT%. Der Browser oeffnet sich automatisch.
echo Dieses schwarze Fenster offen lassen, solange du Toastcord nutzt.
echo Zum Beenden dieses Fenster schliessen oder STRG+C druecken.
echo.
start "" powershell -NoProfile -WindowStyle Hidden -Command "$p=%PORT%; $u=('http://127.0.0.1:'+$p+'/healthz'); for($i=0;$i -lt 40;$i++){try{$x=Invoke-WebRequest -UseBasicParsing -TimeoutSec 1 $u;if($x.StatusCode -eq 200){Start-Process ('http://127.0.0.1:'+$p);exit 0}}catch{};Start-Sleep -Milliseconds 500};Start-Process ('http://127.0.0.1:'+$p)"
"%NODE_CMD%" server.mjs
echo.
echo Toastcord wurde beendet oder konnte nicht gestartet werden.
echo Falls der Start fehlschlaegt, pruefe, ob ein Port zwischen 3000 und 3010 frei ist.
pause
exit /b 0

:no_free_port
echo.
echo Kein freier Port zwischen 3000 und 3010 gefunden.
echo Bitte schliesse eine andere Toastcord-Instanz oder ein Programm, das diese Ports verwendet.
pause
exit /b 1

:download_failed
echo.
echo Die automatische Vorbereitung ist fehlgeschlagen.
echo Bitte pruefe deine Internetverbindung und starte die Datei erneut.
pause
exit /b 1
