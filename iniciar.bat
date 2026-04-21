@echo off
title Foody Monitor - Varandas Pizzaria
echo.
echo  ========================================
echo    Foody Monitor - Varandas Pizzaria
echo  ========================================
echo.

cd /d "%~dp0"

if not exist node_modules (
    echo  Instalando dependencias pela primeira vez...
    npm install
    if errorlevel 1 (
        echo.
        echo  ERRO ao instalar dependencias!
        pause
        exit /b 1
    )
    echo.
)

echo  Iniciando o monitor...
echo  Acesse: http://localhost:3000
echo.
echo  Para parar: feche esta janela ou pressione Ctrl+C
echo.
node server.js
if errorlevel 1 (
    echo.
    echo  ERRO ao iniciar o servidor!
)
pause
