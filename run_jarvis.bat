@echo off
title J.A.R.V.I.S. Mark-LIII
cd /d "%~dp0"
echo Starting J.A.R.V.I.S. Mark-LIII...
call .\venv\Scripts\activate.bat
python main.py
pause
