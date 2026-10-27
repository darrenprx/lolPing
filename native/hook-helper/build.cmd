@echo off
setlocal
set "VSWHERE=%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\vswhere.exe"
if not exist "%VSWHERE%" (
  echo vswhere.exe not found. Install Visual Studio 2022 with the "Desktop development with C++" workload.
  exit /b 1
)
for /f "usebackq tokens=*" %%i in (`"%VSWHERE%" -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath`) do set "VSDIR=%%i"
if not defined VSDIR (
  echo No Visual Studio installation with the C++ x64 tools was found.
  exit /b 1
)
call "%VSDIR%\VC\Auxiliary\Build\vcvars64.bat" >nul || exit /b 1
cd /d "%~dp0"
if not exist build\obj mkdir build\obj
set FLAGS=/nologo /std:c++20 /EHsc /W4 /WX /MT /DUNICODE /D_UNICODE /Fobuild\obj\
cl %FLAGS% /O2 src\main_win.cpp src\hooks_win.cpp src\simulate.cpp src\commands.cpp src\output.cpp src\json.cpp src\decision.cpp /Fe:build\hook-helper.exe /link user32.lib || exit /b 1
cl %FLAGS% /Od tests\helper_tests.cpp src\decision.cpp src\commands.cpp src\macinput.cpp src\json.cpp src\output.cpp /Fe:build\helper_tests.exe || exit /b 1
cl %FLAGS% /O2 src\context_main_win.cpp src\context_capture_win.cpp src\context_text_win.cpp src\context_write_win.cpp src\context.cpp src\json.cpp /Fe:build\context-helper.exe /link user32.lib gdi32.lib ole32.lib oleaut32.lib windowscodecs.lib windowsapp.lib uiautomationcore.lib shell32.lib dwmapi.lib || exit /b 1
cl %FLAGS% /Od tests\context_tests.cpp src\context.cpp src\json.cpp /Fe:build\context_tests.exe || exit /b 1
cl %FLAGS% /O2 ..\..\tools\performance\output-scenario.cpp src\json.cpp src\output.cpp /Fe:build\output-scenario.exe || exit /b 1
cl %FLAGS% /O2 ..\..\tools\performance\decision-scenario.cpp src\decision.cpp /Fe:build\decision-scenario.exe || exit /b 1
echo Built hook-helper.exe, context-helper.exe, helper_tests.exe, context_tests.exe, output-scenario.exe and decision-scenario.exe
