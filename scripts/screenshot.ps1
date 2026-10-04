Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Win32 {
    [DllImport("user32.dll")]
    public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")]
    public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
    [DllImport("user32.dll")]
    public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
    [DllImport("user32.dll")]
    public static extern IntPtr GetForegroundWindow();
}
[StructLayout(LayoutKind.Sequential)]
public struct RECT {
    public int Left, Top, Right, Bottom;
}
"@

# Find Torra Electron process specifically
$procs = Get-Process | Where-Object {
    $_.ProcessName -eq 'electron' -and $_.MainWindowHandle -ne 0
}

if ($procs.Count -eq 0) {
    Write-Host "No Electron window found"
    exit 1
}

# Get the first Electron window with a title
$proc = $procs | Where-Object { $_.MainWindowTitle } | Select-Object -First 1
if (-not $proc) {
    Write-Host "No Electron window with title found"
    exit 1
}

$handle = $proc.MainWindowHandle
Write-Host "Found window: $($proc.MainWindowTitle)"

# Bring window to front
[Win32]::ShowWindow($handle, 9) | Out-Null
Start-Sleep -Milliseconds 300
[Win32]::SetForegroundWindow($handle) | Out-Null
Start-Sleep -Milliseconds 500

# Get window rect
$r = New-Object RECT
[Win32]::GetWindowRect($handle, [ref]$r) | Out-Null

$width = $r.Right - $r.Left
$height = $r.Bottom - $r.Top

Write-Host "Window size: ${width}x${height}"

$bitmap = New-Object System.Drawing.Bitmap($width, $height)
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.CopyFromScreen($r.Left, $r.Top, 0, 0, $bitmap.Size)

$outputPath = Join-Path $PSScriptRoot "screenshot.png"
$bitmap.Save($outputPath, [System.Drawing.Imaging.ImageFormat]::Png)
$graphics.Dispose()
$bitmap.Dispose()

Write-Host "Screenshot saved to: $outputPath"
