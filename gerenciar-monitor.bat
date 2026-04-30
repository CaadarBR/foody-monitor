@echo off
title Foody Monitor - Gerenciar
chcp 65001 > nul

:menu
cls
echo.
echo  ========================================
echo    Foody Monitor - Gerenciamento
echo  ========================================
echo.
echo  Status atual:
pm2 status foody-monitor 2>nul || echo   (PM2 nao esta configurado - rode setup-sempre-ligado.bat)
echo.
echo  O que deseja fazer?
echo   [1] Ver status
echo   [2] Parar o monitor
echo   [3] Iniciar o monitor
echo   [4] Reiniciar o monitor
echo   [5] Ver logs em tempo real
echo   [6] Ver meu IP (para acesso pelo celular)
echo   [0] Sair
echo.
set /p opcao="  Escolha: "

if "%opcao%"=="1" ( pm2 status foody-monitor & pause & goto menu )
if "%opcao%"=="2" ( pm2 stop foody-monitor & echo Monitor parado. & pause & goto menu )
if "%opcao%"=="3" ( pm2 start foody-monitor & echo Monitor iniciado. & pause & goto menu )
if "%opcao%"=="4" ( pm2 restart foody-monitor & echo Monitor reiniciado. & pause & goto menu )
if "%opcao%"=="5" ( pm2 logs foody-monitor & goto menu )
if "%opcao%"=="6" (
    echo.
    echo  Seu IP na rede:
    powershell -Command "Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.*' } | Select-Object -First 1 -ExpandProperty IPAddress | ForEach-Object { Write-Host \"  http://$_`:3000\" }"
    echo.
    pause
    goto menu
)
if "%opcao%"=="0" exit /b 0

goto menu
