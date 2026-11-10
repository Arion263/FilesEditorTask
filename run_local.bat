@echo off
REM ============================================================================
REM Script para Windows: Instalar dependencias y levantar el servicio en local
REM ============================================================================

echo [1/3] Verificando entorno virtual de Python (.venv)...
if not exist ".venv" (
    echo Creando entorno virtual...
    python -m venv .venv
)

echo [2/3] Instalando dependencias de Python y Node.js...
call .\.venv\Scripts\pip install -r requirements-dev.txt --quiet
call npm install --no-audit --no-fund

echo [3/3] Iniciando Next.js (puerto 3000) y Flask API (puerto 5328)...
set "PATH=%CD%\.venv\Scripts;%PATH%"
call npm run dev
