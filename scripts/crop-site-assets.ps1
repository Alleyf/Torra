# 落地页配图：把两张老实拍图裁掉标题栏。
#
# 为什么裁：这两张拍于标题栏改版之前（64px 高、导航带文字），而落地页要展示的
# 是现在这副图标态。整窗直接放上去，等于在同一页里出现两种标题栏。
# 裁掉最上面那 64px 只留内容区，既不用伪造界面，也不会自相矛盾。
#
# 研讨与结论那两张以前也走这里，现在不用了：npm run shots 直接按当前构建重拍了
# 整窗图（site/assets/flow.png、consensus.png），标题栏本来就是新的，裁它反而啃内容。
# 新拍的整窗图（site/assets/app-*.png）由 scripts/capture-site.mjs 出，也不经过这里。
#
# 用法：powershell -ExecutionPolicy Bypass -File scripts/crop-site-assets.ps1
Add-Type -AssemblyName System.Drawing

$root = Split-Path -Parent $PSScriptRoot
$top = 64   # 改版前 --titlebar-h 的值

$jobs = @(
  @{ src = 'docs\settings-assistant-dark.png'; dst = 'site\assets\assistant.png' },
  @{ src = 'docs\chat-cards-dark.png'; dst = 'site\assets\cards.png' }
)

foreach ($j in $jobs) {
  $src = Join-Path $root $j.src
  $dst = Join-Path $root $j.dst
  if (-not (Test-Path $src)) { Write-Host ("跳过（源图不存在）：" + $src) -ForegroundColor Yellow; continue }
  $img = [System.Drawing.Image]::FromFile($src)
  $w = $img.Width
  $h = $img.Height - $top
  $bmp = New-Object System.Drawing.Bitmap $w, $h
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  # 第二矩形是「从源图取哪一块」，起点 y=$top 就是把标题栏那一条丢掉
  $g.DrawImage($img,
    (New-Object System.Drawing.Rectangle 0, 0, $w, $h),
    (New-Object System.Drawing.Rectangle 0, $top, $w, $h),
    [System.Drawing.GraphicsUnit]::Pixel)
  $g.Dispose(); $img.Dispose()
  $bmp.Save($dst, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
  Write-Host ("  ✓ {0}  {1}×{2}" -f $j.dst, $w, $h) -ForegroundColor Green
}
