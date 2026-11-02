# Validates one evidence PNG: exists, size, PNG signature, minimum dimensions,
# visually non-blank (sampled color diversity + brightness spread), and —
# optionally — dark-application average brightness (rejects captures of a
# foreign bright window: the Teaching IDE is always dark-themed).
# Usage: powershell -File validate-png.ps1 -Path <png> -MinWidth <n> -MinHeight <n> [-MaxAverageBrightness <n>]
# Prints PNG_OK <path> (<WxH> colors=<n>) or PNG_BAD <reason>; exit 0/1.
param(
  [Parameter(Mandatory = $true)][string]$Path,
  [Parameter(Mandatory = $true)][int]$MinWidth,
  [Parameter(Mandatory = $true)][int]$MinHeight,
  [int]$MaxAverageBrightness = 1000
)

Add-Type -AssemblyName System.Drawing

if (-not (Test-Path $Path)) {
  Write-Output "PNG_BAD missing $Path"
  exit 1
}
$bytes = [IO.File]::ReadAllBytes($Path)
if ($bytes.Length -lt 10000) {
  Write-Output "PNG_BAD small $Path ($($bytes.Length) bytes)"
  exit 1
}
if (-not ($bytes[0] -eq 137 -and $bytes[1] -eq 80 -and $bytes[2] -eq 78 -and $bytes[3] -eq 71)) {
  Write-Output "PNG_BAD signature $Path"
  exit 1
}
try {
  $bmp = New-Object Drawing.Bitmap($Path)
  $w = $bmp.Width
  $h = $bmp.Height
  if ($w -lt $MinWidth -or $h -lt $MinHeight) {
    Write-Output "PNG_BAD dims $Path (${w}x${h}, want >= ${MinWidth}x${MinHeight})"
    $bmp.Dispose()
    exit 1
  }
  $seen = New-Object Collections.Generic.HashSet[int]
  $minB = 255
  $maxB = 0
  $total = 0
  $samples = 0
  for ($gx = 0; $gx -lt 12; $gx++) {
    for ($gy = 0; $gy -lt 12; $gy++) {
      $px = $bmp.GetPixel([int]($w * ($gx + 0.5) / 12), [int]($h * ($gy + 0.5) / 12))
      $seen.Add($px.ToArgb()) | Out-Null
      $b = [int](($px.R + $px.G + $px.B) / 3)
      if ($b -lt $minB) { $minB = $b }
      if ($b -gt $maxB) { $maxB = $b }
      $total += $b
      $samples++
    }
  }
  $bmp.Dispose()
  $spread = $maxB - $minB
  $average = [int]($total / $samples)
  # Dark-theme application windows sample few distinct colors on a coarse
  # grid (reference P5 evidence: 15 colors); the blank-capture detector is
  # therefore uniformity (too few colors) AND flatness (no contrast), not
  # color count alone. A truly blank capture is 1 color with ~0 spread.
  if ($seen.Count -lt 3 -or $spread -lt 30) {
    Write-Output "PNG_BAD blank $Path (colors=$($seen.Count) spread=$spread)"
    exit 1
  }
  # Foreign-window detector: the Teaching IDE averages ≈ 40 brightness; a
  # bright foreign window (e.g. an occluding office app) averages ≈ 250.
  if ($average -gt $MaxAverageBrightness) {
    Write-Output "PNG_BAD bright $Path (average=$average, want <= $MaxAverageBrightness)"
    exit 1
  }
  Write-Output "PNG_OK $Path (${w}x${h} colors=$($seen.Count) spread=$spread average=$average)"
  exit 0
} catch {
  Write-Output "PNG_BAD decode $Path"
  exit 1
}
