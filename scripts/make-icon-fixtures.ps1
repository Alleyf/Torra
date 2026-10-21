# Build the offline icon fixtures used by the docs screenshots.
# scripts/smoke.js serves them over torra-icon:// so the model rail draws real
# brand marks even when this machine has no route to the favicon CDNs.
#
# Source: the app's own favicon disk cache (%APPDATA%/torra/torra/icons),
# i.e. whatever the running app pulled from its public favicon chain.
# We downscale to 64px PNG so the repo stays light: the UI draws these at
# 18-34px and the docs shots capture at scale 2, so 64px is still a downsample.
# Keep this file ASCII-only - Windows PowerShell 5 misreads UTF-8 without BOM.
#
# One known gap: chatgpt.com is served as WEBP, and System.Drawing cannot
# decode that on this box, so the loop reports "skip (decode failed)" and
# leaves the file alone. If it ever goes missing, copy the cache file over
# as-is - scripts/smoke.js sniffs the magic bytes and will serve image/webp.
Add-Type -AssemblyName System.Drawing

$root = Split-Path -Parent $PSScriptRoot
$src  = Join-Path $env:APPDATA 'torra\torra\icons'
$dst  = Join-Path $root 'scripts\fixtures\icons'
New-Item -ItemType Directory -Force -Path $dst | Out-Null

# Exactly the hosts that scripts/smoke.js puts a domain on. An API model has
# no entry URL to read a host from, so giving it a fixture icon would be a
# picture the real app can never draw.
$domains = @('chatgpt.com','claude.ai','gemini.google.com')
$side = 64

foreach ($d in $domains) {
  $in = Join-Path $src $d
  if (-not (Test-Path $in)) { Write-Host ("  skip (no source): " + $d) -ForegroundColor Yellow; continue }
  try { $img = [System.Drawing.Image]::FromFile($in) }
  catch { Write-Host ("  skip (decode failed): " + $d) -ForegroundColor Yellow; continue }
  $bmp = New-Object System.Drawing.Bitmap $side, $side
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.PixelOffsetMode   = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $g.SmoothingMode     = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
  $g.DrawImage($img, (New-Object System.Drawing.Rectangle 0, 0, $side, $side),
                    (New-Object System.Drawing.Rectangle 0, 0, $img.Width, $img.Height),
                    [System.Drawing.GraphicsUnit]::Pixel)
  $g.Dispose(); $img.Dispose()
  $out = Join-Path $dst $d
  $bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
  Write-Host ("  ok {0}  {1}KB" -f $d, [math]::Round((Get-Item $out).Length/1KB, 1)) -ForegroundColor Green
}
