@echo off
rem ============================================================================
rem  drc-relay-install.cmd — 把中继装成 Windows 服务（V3-PLAN D1 / §6.3）
rem
rem  为什么需要这个：v2 只有 Linux（systemd）与容器两条路，Windows 上没有配方。
rem 而"服务停止"在 Windows 上是**硬杀**——Node 收不到 SIGTERM，
rem 于是排空（close）与兜底落盘（forceShutdown）一次都不跑（见 §A3 / lifecycle.ts）。
rem 装成服务之后至少有了「停止 = 走一遍优雅停机」这条��。
rem
rem  用法（管理员 PowerShell 或 cmd）：
rem   1) 先构建（Linux/macOS 同理）：pnpm -C packages/relay build
rem   2) 设好环境变量（见下）
rem   3) drc-relay-install.cmd install
rem
rem  依赖：NSSM（把任意 exe 变成 Windows 服务）。这是**外部**依赖，不进本仓——
rem  它是 Windows 上没有内置 service wrapper 的事实所迫（systemd 是 Linux 自带的）。
rem  下载：https://nssm.cc/ （解压后把 nssm.exe 放到 PATH，或用 NSSM 环境变量指到它）
rem ============================================================================
setlocal enabledelayedexpansion

set "APP_DIR=%~dp0..\server"
set "SERVICE_NAME=dsh-remote-relay"
set "DISPLAY_NAME=DSH Remote Control Relay (zero-knowledge)"
set "DESCRIPTION=DSH Remote Control 的零知识中继。只做路由，不碰载荷明文。"
set "NSSM=%NSSM%"

if "%NSSM%"=="" set "NSSM=nssm.exe"

if not exist "%APP_DIR%\relay.mjs" (
  echo [x] 找不到 %APP_DIR%\relay.mjs
  echo     先构建并拷贝产物：pnpm -C packages/relay build
  echo     然后把 dist\bundle\main.js 放到 %APP_DIR%\relay.mjs
  exit /b 1
)

rem ── 环境变量：凭据不进命令行历史，也不进服务描述 ───────────────────────────
rem ⚠️ 中继**没有** hostToken 就在启动时拒绝（这是协议层纪律）。
rem    所以下面两行必须配好，否则服务起来又立刻退出，日志里只有 "fatal"。
if "%DRC_HOST_TOKEN%"=="" (
  echo [!] 未设 DRC_HOST_TOKEN。中继缺它会**拒绝启动**——先设好再装。
  echo     临时设：set DRC_HOST_TOKEN=...  ^(openssl rand -hex 32 生成^)
  exit /b 1
)

if /i "%~1"=="install" goto :install
if /i "%~1"=="uninstall" goto :uninstall
if /i "%~1"=="status" goto :status
goto :usage

:install
echo [1/4] 注册服务 %SERVICE_NAME% ...
"%NSSM%" install "%SERVICE_NAME%" "%APP_DIR%\relay.mjs"
if errorlevel 1 goto :nssm_failed

echo [2/4] 设置 AppDirectory ...
"%NSSM%" set "%SERVICE_NAME%" AppDirectory "%APP_DIR%"

echo [3/4] 设置环境变量（凭据 / 端口 / 绑定）...
rem  nssm set 会把值写进服务配置，落在注册表里 —— 所以这台机器的凭据由它的 ACL 守着。
rem  **不要**把 hostToken 写进 deploy 文件或文档示例里。
"%NSSM%" set "%SERVICE_NAME%" AppEnvironmentExtra "DRC_HOST_TOKEN=%DRC_HOST_TOKEN%" "DRC_PORT=%DRC_PORT%" "DRC_BIND=127.0.0.1" "DRC_LOG_LEVEL=info"
if "%DRC_STATE_FILE%"=="" (
  echo     提示：未设 DRC_STATE_FILE = 重启丢失全部配对（纯内存）。生产请设。
) else (
  "%NSSM%" set "%SERVICE_NAME%" AppEnvironmentExtra "DRC_STATE_FILE=%DRC_STATE_FILE%"
)

echo [4/4] 配置日志与重启策略 ...
rem  默认级别 info：debug 会把**完整配对码**打进日志（server.ts）。
"%NSSM%" set "%SERVICE_NAME%" AppStdout "%APP_DIR%\logs\relay.out.log"
"%NSSM%" set "%SERVICE_NAME%" AppStderr "%APP_DIR%\logs\relay.err.log"
"%NSSM%" set "%SERVICE_NAME%" AppRotateFiles 1
"%NSSM%" set "%SERVICE_NAME%" AppRotateBytes 10485760
rem  服务被停止时先发 Ctrl+C（= SIGINT）而不是 TerminateProcess：
rem 那 5 秒里排空与兜底落盘才跑得起来（lifecycle.ts 的 registerSignalHandlers）。
"%NSSM%" set "%SERVICE_NAME%" AppStopMethodConsole 15000

if not exist "%APP_DIR%\logs" mkdir "%APP_DIR%\logs"

echo.
echo ✅ 已安装为服务。常用命令：
echo    %NSSM% start   %SERVICE_NAME%     启动
echo    %NSSM% stop    %SERVICE_NAME%     停止（走优雅停机）
echo    %NSSM% status  %SERVICE_NAME%     看状态
echo.
echo ⚠️ 反代与防火墙（这一步**不能省**）：
echo    - TLS 由反代终止（IIS / nginx / Caddy）。中继只绑 127.0.0.1。
echo    - 反代必须转发 WebSocket 升级头（Upgrade / Connection / Host）。
echo    - 防火墙：**不要**把 8787 暴露到公网（那样就绕过了反代的按 IP 限流）。
exit /b 0

:uninstall
"%NSSM%" stop "%SERVICE_NAME%" >nul 2>&1
"%NSSM%" remove "%SERVICE_NAME%" confirm
echo ✅ 已卸载服务（%APP_DIR% 下的文件与日志保留）。
exit /b 0

:status
"%NSSM%" status "%SERVICE_NAME%"
exit /b 0

:nssm_failed
echo [x] NSSM 调用失败。检查 "%NSSM%" 是否可用（set NSSM=D:\path\to\nssm.exe）。
exit /b 1

:usage
echo 用法：
echo   %~nx0 install      装成 Windows 服务（需要管理员）
echo   %~nx0 status       看服务状态
echo   %~nx0 uninstall    卸载服务
echo.
echo 前置：pnpm -C packages/relay build，并把 dist\bundle\main.js 放到 %APP_DIR%\relay.mjs
exit /b 1