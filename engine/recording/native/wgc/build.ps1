# P9.2 native WGC build — proof EXE (direct cl) + N-API addon (node-gyp).
# Usage from the repository root:
#   powershell -ExecutionPolicy Bypass -File engine\recording\native\wgc\build.ps1
# Targets: -Target All | Proof | Addon. Writes the proof EXE under temp/
# (ignored) and the addon under native/wgc/build/ (ignored). No SDK installs:
# uses the installed VS 18 MSVC toolchain + Windows SDK only.
param([string]$Target = "All")

$ErrorActionPreference = "Stop"
$wgcDir = Split-Path $PSCommandPath
$repoRoot = Split-Path (Split-Path (Split-Path (Split-Path $wgcDir)))
$outDir = Join-Path $repoRoot "temp\p9.2-native"
New-Item -ItemType Directory -Force -Path $outDir | Out-Null

$vcvars = "C:\Program Files\Microsoft Visual Studio\18\Community\VC\Auxiliary\Build\vcvars64.bat"
if (-not (Test-Path -LiteralPath $vcvars)) {
  $vswhere = "C:\Program Files (x86)\Microsoft Visual Studio\Installer\vswhere.exe"
  if (Test-Path -LiteralPath $vswhere) {
    $install = & $vswhere -products * -requires Microsoft.VisualStudio.Component.VC.Tools -property installationPath | Select-Object -First 1
    $vcvars = Join-Path $install "VC\Auxiliary\Build\vcvars64.bat"
  }
}
if (-not (Test-Path -LiteralPath $vcvars)) { throw "MSVC vcvars64.bat not found" }

Write-Host "Using toolchain: $vcvars"
$envDump = & cmd /c "`"$vcvars`" >NUL & set"
foreach ($line in $envDump) {
  $sep = $line.IndexOf("=")
  if ($sep -gt 0) {
    $name = $line.Substring(0, $sep)
    $value = $line.Substring($sep + 1)
    Set-Item -Path ("env:" + $name) -Value $value
  }
}
if (-not (Get-Command cl.exe -ErrorAction SilentlyContinue)) { throw "cl.exe not on PATH after vcvars" }

if ($Target -eq "All" -or $Target -eq "Proof") {
  Write-Host "--- Building wgc-proof.exe ---"
  $objDir = Join-Path $outDir "obj"
  New-Item -ItemType Directory -Force -Path $objDir | Out-Null
  Push-Location (Join-Path $wgcDir "src")
  try {
    & cl.exe /nologo /EHsc /std:c++17 /W4 /DUNICODE /D_UNICODE /DWIN32_LEAN_AND_MEAN /DNOMINMAX `
      proof.cc wgc_core.cc `
      /Fe:(Join-Path $outDir "wgc-proof.exe") `
      /Fo:(Join-Path $objDir "") `
      /link d3d11.lib windowsapp.lib runtimeobject.lib ntdll.lib user32.lib gdi32.lib shell32.lib
    if ($LASTEXITCODE -ne 0) { throw "proof build failed" }
  } finally {
    Pop-Location
  }
  Write-Host "Proof EXE: $(Join-Path $outDir 'wgc-proof.exe')"
}

if ($Target -eq "All" -or $Target -eq "Addon") {
  Write-Host "--- Building wgc_capture.node (direct cl + node headers) ---"
  Write-Host "wgcDir: $wgcDir"
  # node-gyp cannot detect VS 18 (2026); the equivalent compile is driven
  # directly with the same sources/flags/libs binding.gyp declares.
  $headersRoot = Join-Path $repoRoot "temp\node-headers"
  New-Item -ItemType Directory -Force -Path $headersRoot | Out-Null
  Push-Location $repoRoot
  try {
    & npx --yes node-gyp@11 install --devdir=(Join-Path $headersRoot "")
    if ($LASTEXITCODE -ne 0) { throw "node headers fetch failed" }
  } finally {
    Pop-Location
  }
  $nodeVersion = (& node -p "process.version").Trim().TrimStart("v")
  $nodeInclude = Join-Path $headersRoot "$nodeVersion\include\node"
  $nodeLibDir = Join-Path $headersRoot "$nodeVersion\x64"
  if (-not (Test-Path -LiteralPath (Join-Path $nodeInclude "node_api.h"))) { throw "node_api.h missing" }
  if (-not (Test-Path -LiteralPath (Join-Path $nodeLibDir "node.lib"))) { throw "node.lib missing" }
  $addonOut = Join-Path $wgcDir "build\Release"
  $addonObj = Join-Path $wgcDir "build\obj"
  New-Item -ItemType Directory -Force -Path $addonOut, $addonObj | Out-Null
  Push-Location (Join-Path $wgcDir "src")
  try {
    # P9.2 corrective (proven): the N-API imports must DELAY-load node.exe
    # via the canonical node-gyp hook (src/win_delay_load_hook.cc,
    # HOST_BINARY=node.exe, delayimp.lib). A hard node.exe import resolves
    # under node.exe but terminates Electron Main during require().
    & cl.exe /nologo /EHsc /std:c++17 /W4 /DUNICODE /D_UNICODE /DWIN32_LEAN_AND_MEAN /DNOMINMAX `
      /DNODE_GYP_MODULE_NAME=wgc_capture /DBUILDING_NODE_EXTENSION `
      '/D"HOST_BINARY=\"node.exe\""' `
      "/I$nodeInclude" `
      addon.cc wgc_core.cc win_delay_load_hook.cc `
      /Fe:(Join-Path $addonOut "wgc_capture.node") `
      /Fo:(Join-Path $addonObj "") `
      /LD "/link" "/LIBPATH:$nodeLibDir" node.lib delayimp.lib "/DELAYLOAD:node.exe" d3d11.lib windowsapp.lib runtimeobject.lib ntdll.lib user32.lib gdi32.lib
    if ($LASTEXITCODE -ne 0) { throw "addon build failed" }
  } finally {
    Pop-Location
  }
  Write-Host "Addon: $(Join-Path $addonOut 'wgc_capture.node')"
}

Write-Host "BUILD OK"
