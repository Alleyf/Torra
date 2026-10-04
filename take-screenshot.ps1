Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
public class Win32 {
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
}
"@

$procs = Get-Process | Where-Object { $_.ProcessName -eq 'electron' -and $_.MainWindowTitle -like '*Torra*' }
$torra = $procs | Select-Object -Last 1

if (-not $torra) {
    Write-Host "No Torra window found"
    exit 1
}

[Win32]::ShowWindow($torra.MainWindowHandle, 9) | Out-Null
Start-Sleep -Milliseconds 500
[Win32]::SetForegroundWindow($torra.MainWindowHandle) | Out-Null
Start-Sleep -Milliseconds 800

$rect = New-Object RECT
[Win32]::GetWindowRect($torra.MainWindowHandle, [ref]$rect) | Out-Null

$w = $rect.Right - $rect.Left
$h = $rect.Bottom - $rect.Top

$bmp = New-Object System.Drawing.Bitmap($w, $h)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($rect.Left, $rect.Top, 0, 0, (New-Object System.Drawing.Size($w, $h)))
$bmp.Save("A:\dashboard\GH_Repos\Torra\screenshot.png")
$g.Dispose()
$bmp.Dispose()

Write-Host "Screenshot saved"
