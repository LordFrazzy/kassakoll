@echo off
cd /d "%~dp0"
echo Startar Kassakoll pa http://localhost:8000
echo Stang det har fonstret for att stoppa sidan.
start "" cmd /c "timeout /t 2 /nobreak >nul & start http://localhost:8000"
where python >nul 2>nul && (python -m http.server 8000 & goto :eof)
where py >nul 2>nul && (py -m http.server 8000 & goto :eof)
npx --yes serve -l 8000
