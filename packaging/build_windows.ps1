# 在 Windows 上构建 RNA Studio.exe 并打成 zip 分发包
#
# 前置条件（本机需联网）：
#   · Python 3.9+（安装时勾选 "Add python.exe to PATH"）
#   · JDK 17+（提供 jlink.exe，用来生成随包的精简 JRE）
#       建议： winget install EclipseAdoptium.Temurin.21.JDK
#   若没装 JDK，脚本会跳过 JRE 打包，装出来的应用出图时会去找系统 Java。
#
# 用法（在项目根目录执行）：
#   powershell -ExecutionPolicy Bypass -File packaging\build_windows.ps1
# 产物：  dist\RNA Studio\RNA Studio.exe
#         以及 release\RNA-Studio-<版本>-Windows-x64.zip

# 注意：本文件必须保存为「带 UTF-8 BOM」的编码。
# Windows PowerShell 5.1 在没有 BOM 时会按系统 ANSI 代码页读取脚本，
# 导致下面的中文字符串变成乱码、脚本直接解析失败（已踩过这个坑）。
# 用 VS Code 保存时选「UTF-8 with BOM」，或用编辑器保留现有 BOM。

$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $Root

$AppName = "RNA Studio"
$Version = "1.1.0"
$Out = Join-Path $Root "release"

Write-Host "==> 项目目录：$Root"

# ───────────────────────── 1. Python 依赖 ─────────────────────────

$Venv = Join-Path $Root ".venv-build"
if (-not (Test-Path $Venv)) {
    Write-Host "==> 创建构建用虚拟环境"
    python -m venv $Venv
}

$Py = Join-Path $Venv "Scripts\python.exe"
Write-Host "==> 安装依赖"
& $Py -m pip install --upgrade pip | Out-Null
& $Py -m pip install -r requirements.txt -r requirements-desktop.txt
if ($LASTEXITCODE -ne 0) { throw "依赖安装失败" }

# ───────────────────────── 2. 精简 JRE ─────────────────────────

$Jre = Join-Path $Root "jre"
if (Test-Path $Jre) { Remove-Item -Recurse -Force $Jre }

$Jlink = $null
$cmd = Get-Command jlink -ErrorAction SilentlyContinue
if ($cmd) {
    $Jlink = $cmd.Source
} elseif ($env:JAVA_HOME -and (Test-Path (Join-Path $env:JAVA_HOME "bin\jlink.exe"))) {
    $Jlink = Join-Path $env:JAVA_HOME "bin\jlink.exe"
} else {
    # 常见 JDK 安装位置
    foreach ($base in @("C:\Program Files\Eclipse Adoptium", "C:\Program Files\Java", "C:\Program Files\Microsoft")) {
        if (Test-Path $base) {
            $found = Get-ChildItem -Path $base -Filter "jlink.exe" -Recurse -ErrorAction SilentlyContinue |
                     Select-Object -First 1
            if ($found) { $Jlink = $found.FullName; break }
        }
    }
}

if ($Jlink) {
    Write-Host "==> 用 jlink 生成精简 JRE（VARNA 需要 java.desktop）"
    & $Jlink --add-modules java.base,java.desktop,java.logging,java.prefs `
             --strip-debug --no-man-pages --no-header-files --compress=zip-6 `
             --output $Jre
    if ($LASTEXITCODE -ne 0) { throw "jlink 失败" }
    $size = "{0:N0} MB" -f ((Get-ChildItem $Jre -Recurse | Measure-Object -Property Length -Sum).Sum / 1MB)
    Write-Host "    大小：$size"
} else {
    Write-Host "==> 未找到 jlink，跳过 JRE 打包。"
    Write-Host "    应用仍可用，但 VARNA 出图需要用户机器上装了 Java。"
    Write-Host "    想带上 JRE 的话： winget install EclipseAdoptium.Temurin.21.JDK 后重跑本脚本。"
}

# ───────────────────────── 3. PyInstaller ─────────────────────────

Write-Host "==> 打包"
$DistPath = Join-Path $Root "dist"
$BuildPath = Join-Path $Root "build"
if (Test-Path $DistPath) { Remove-Item -Recurse -Force $DistPath }
if (Test-Path $BuildPath) { Remove-Item -Recurse -Force $BuildPath }

& $Py -m PyInstaller --noconfirm --clean `
    --distpath $DistPath --workpath $BuildPath `
    packaging\rna-studio.spec
if ($LASTEXITCODE -ne 0) { throw "PyInstaller 打包失败" }

$AppDir = Join-Path $DistPath $AppName
$ExePath = Join-Path $AppDir "$AppName.exe"
if (-not (Test-Path $ExePath)) { throw "没有生成 $ExePath" }

# ───────────────────────── 4. 打 ZIP ─────────────────────────

New-Item -ItemType Directory -Force -Path $Out | Out-Null
Get-ChildItem $Out -Filter "*.zip" -ErrorAction SilentlyContinue | Remove-Item -Force

$ReadmePath = Join-Path $AppDir "首次使用请先读我.txt"
# 注意：here-string 的结束标记 "@ 必须单独占一行行首，且插值用 ${} 明确边界
$ReadmeText = @"
RNA Studio ${Version}
=====================================

直接双击「${AppName}.exe」即可启动，会打开一个独立的应用窗口。
不需要安装 Python，也不需要单独装 Java（已随包附带）。

首次运行 Windows 可能弹出 SmartScreen 提示「已保护你的电脑」，
这是因为程序没有购买代码签名证书。点「更多信息」→「仍要运行」即可，
只需一次。

如果双击后没有任何反应，请查看同目录下的 rna-studio.log，
里面记录了服务地址，可手动在浏览器中打开。
"@
$ReadmeText | Set-Content -Path $ReadmePath -Encoding UTF8

$Zip = Join-Path $Out "RNA-Studio-$Version-Windows-x64.zip"
Write-Host "==> 生成 ZIP"
Compress-Archive -Path $AppDir -DestinationPath $Zip -CompressionLevel Optimal

Write-Host ""
Write-Host "==> 完成"
Write-Host "    程序：$ExePath"
Write-Host "    分发包：$Zip"
