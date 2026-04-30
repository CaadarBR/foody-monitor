@echo off
setlocal enabledelayedexpansion
title Foody Monitor - Setup Sempre Ligado
chcp 65001 > nul
echo.
echo  ========================================
echo    Foody Monitor - Setup Sempre Ligado
echo  ========================================
echo.
echo  Este script vai configurar o monitor para
echo  iniciar automaticamente com o Windows.
echo.

cd /d "%~dp0"

:: Verifica se PM2 já está instalado
pm2 --version > nul 2>&1
if errorlevel 1 (
    echo  [1/3] Instalando PM2...
    npm install -g pm2
    if errorlevel 1 (
        echo.
        echo  ERRO ao instalar PM2! Verifique se o Node.js esta instalado.
        pause
        exit /b 1
    )
) else (
    echo  [1/3] PM2 ja esta instalado. OK
)

:: Instala o módulo de startup do Windows
echo.
echo  [2/3] Configurando inicializacao automatica...
npm install -g pm2-windows-startup > nul 2>&1
pm2-startup install > nul 2>&1

:: Para qualquer instância anterior e inicia nova
echo.
echo  [3/3] Iniciando o servidor Foody Monitor...
pm2 delete foody-monitor > nul 2>&1
pm2 start server.js --name "foody-monitor" --restart-delay=3000
pm2 save

echo.
echo  ========================================
echo    Configuracao concluida!
echo  ========================================
echo.
echo  O monitor agora:
echo   - Esta rodando em segundo plano
echo   - Inicia automaticamente com o Windows
echo   - Reinicia sozinho se cair
echo.
echo  Para acessar neste computador:
echo   http://localhost:3000
echo.
echo  Para acessar pelo CELULAR (mesma rede WiFi), use o IP abaixo:
powershell -Command "Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.*' } | Select-Object -First 1 -ExpandProperty IPAddress | ForEach-Object { Write-Host \"  http://$_`:3000\" }"
echo.
pause
