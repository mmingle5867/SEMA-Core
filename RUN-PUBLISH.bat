@echo off
setlocal EnableExtensions DisableDelayedExpansion

echo SEMA Core GitHub Publisher
echo.

set "EXPECTED_REMOTE=https://github.com/mmingle5867/SEMA-Core.git"
set "PROJECT_ROOT=%~dp0"
pushd "%PROJECT_ROOT%" || goto :failure

where git >nul 2>nul || (
  echo ERROR: Git is not installed or is not available on PATH.
  goto :failure
)

if not exist ".git" (
  echo Initializing this extracted SEMA Core source as a Git repository...
  git init -b main || goto :failure
)

for /f "usebackq delims=" %%R in (`git remote get-url origin 2^>nul`) do set "CURRENT_REMOTE=%%R"
if defined CURRENT_REMOTE (
  git remote set-url origin "%EXPECTED_REMOTE%" || goto :failure
) else (
  git remote add origin "%EXPECTED_REMOTE%" || goto :failure
)

git branch -M main || goto :failure

echo Staging SEMA Core source and documentation...
git add -A || goto :failure
git diff --cached --quiet
if errorlevel 1 (
  git commit -m "feat: establish standalone SEMA Core" || goto :failure
) else (
  echo No uncommitted source changes to commit.
)

echo.
echo Pushing to GitHub. If Git requests sign-in, complete it in the browser or credential prompt.
git push -u origin main || goto :failure

echo.
echo PUBLISH COMPLETE.
git status --short --branch
popd
pause
exit /b 0

:failure
echo.
echo PUBLISH FAILED. Review the error above. No source files were deleted.
popd
pause
exit /b 1
