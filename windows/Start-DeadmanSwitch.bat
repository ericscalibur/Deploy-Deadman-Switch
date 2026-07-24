@echo off
REM Starts the Deploy Deadman Switch server.
REM This file lives in the windows\ subfolder; the app root is one level up.
cd /d "%~dp0.."
node server.js
