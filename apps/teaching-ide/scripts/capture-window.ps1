# Captures the Teaching IDE window to a PNG (evidence for P4 validation).
# Usage: powershell -File capture-window.ps1 -OutPath <path.png>
# Captures the window rect only - no desktop content outside the app window.
param(
  [Parameter(Mandatory = $true)][string]$OutPath
)

Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Win32Capture {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr hwnd, int attr, out RECT rect, int attrSize);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
}
"@

$candidates = @(Get-Process | Where-Object { $_.MainWindowTitle -like "*Teaching IDE*" -and $_.MainWindowHandle -ne 0 })
if ($candidates.Count -eq 0) {
  Write-Error "Teaching IDE window not found"
  exit 1
}
if ($candidates.Count -gt 1) {
  # Overlapping same-titled windows break window targeting AND evidence
  # attribution: fail loudly (the gate enforces single-window discipline
  # and retries with a fresh window) instead of archiving ambiguity.
  $summary = ($candidates | ForEach-Object { "pid=$($_.Id) handle=$($_.MainWindowHandle)" }) -join "; "
  Write-Error "multiple Teaching IDE windows ($($candidates.Count)): $summary"
  exit 1
}
$process = $candidates[0]

$hwnd = $process.MainWindowHandle
if ([Win32Capture]::IsIconic($hwnd)) {
  # 9 = SW_RESTORE: restore an iconified/minimized window before capturing.
  [Win32Capture]::ShowWindow($hwnd, 9) | Out-Null
  Start-Sleep -Milliseconds 600
}
Write-Output "target pid=$($process.Id) handle=$hwnd minimized=$([Win32Capture]::IsIconic($hwnd)) visible=$([Win32Capture]::IsWindowVisible($hwnd))"
# Best-effort foreground: bringing the window forward can be refused by the
# OS foreground policy (a background launcher has no foreground rights). A
# refused switch is NOT fatal here; the capture brightness gate remains the
# arbiter of what was captured (a refused switch over an occluded window
# fails there, never silently).
$setFrontAttempts = 0
while ($setFrontAttempts -lt 1) {
  [Win32Capture]::SetForegroundWindow($hwnd) | Out-Null
  Start-Sleep -Milliseconds 400
  if ([Win32Capture]::GetForegroundWindow() -eq $hwnd) { break }
  $setFrontAttempts++
  Start-Sleep -Milliseconds 300
}
if ([Win32Capture]::GetForegroundWindow() -ne $hwnd) {
  Write-Output "warning: Teaching IDE window is not foreground (capture proceeds; brightness gate arbitrates)"
}

$rect = New-Object Win32Capture+RECT
# DWMWA_EXTENDED_FRAME_BOUNDS = 9: the VISIBLE window bounds (excludes the
# invisible DWM drop-shadow margins that GetWindowRect includes).
$dwmResult = [Win32Capture]::DwmGetWindowAttribute($hwnd, 9, [ref]$rect, [System.Runtime.InteropServices.Marshal]::SizeOf($rect))
if ($dwmResult -ne 0) {
  [Win32Capture]::GetWindowRect($hwnd, [ref]$rect) | Out-Null
}
$width = $rect.Right - $rect.Left
$height = $rect.Bottom - $rect.Top
if ($width -le 0 -or $height -le 0) {
  # Transient DWM rect failure (window mid-transition): one bounded re-query.
  Start-Sleep -Milliseconds 500
  $dwmResult = [Win32Capture]::DwmGetWindowAttribute($hwnd, 9, [ref]$rect, [System.Runtime.InteropServices.Marshal]::SizeOf($rect))
  if ($dwmResult -ne 0) {
    [Win32Capture]::GetWindowRect($hwnd, [ref]$rect) | Out-Null
  }
  $width = $rect.Right - $rect.Left
  $height = $rect.Bottom - $rect.Top
  if ($width -le 0 -or $height -le 0) {
    Write-Error "invalid window rect"
    exit 1
  }
}

$bitmap = New-Object System.Drawing.Bitmap($width, $height)
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.CopyFromScreen($rect.Left, $rect.Top, 0, 0, (New-Object System.Drawing.Size($width, $height)))
$graphics.Dispose()

# double DPI scaling: if the captured bitmap is 2x the window size, rescale
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $OutPath) | Out-Null
$bitmap.Save($OutPath, [System.Drawing.Imaging.ImageFormat]::Png)
$bitmap.Dispose()
Write-Output "saved $OutPath ($width x $height)"
