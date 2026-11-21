param([string]$OutDir = (Join-Path $PSScriptRoot 'icons'))
Add-Type -AssemblyName System.Drawing
$outDir = $OutDir
New-Item -ItemType Directory -Force $outDir | Out-Null

# 5x7 glyphs, 5 wide keeps the digit centred inside an odd-sized canvas
$glyphs = @{
  '0' = @('01110','10001','10001','10001','10001','10001','01110')
  '1' = @('00100','01100','00100','00100','00100','00100','01110')
  '2' = @('01110','10001','00001','00010','00100','01000','11111')
  '3' = @('11110','00001','00001','01110','00001','00001','11110')
  '4' = @('00010','00110','01010','10010','11111','00010','00010')
  '5' = @('11111','10000','11110','00001','00001','10001','01110')
  '6' = @('01110','10000','10000','11110','10001','10001','01110')
  '7' = @('11111','00001','00010','00100','01000','01000','01000')
  '8' = @('01110','10001','10001','01110','10001','10001','01110')
  '9' = @('01110','10001','10001','01111','00001','00001','01110')
}

$red = [System.Drawing.Color]::FromArgb(255, 229, 72, 77)
$white = [System.Drawing.Color]::White

function New-Badge([int]$size, [int]$dot, [string]$label) {
  $bmp = New-Object System.Drawing.Bitmap($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.Clear([System.Drawing.Color]::Transparent)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias

  $charW = 5 * $dot
  $totalH = 7 * $dot
  $x0 = [int][math]::Floor(($size - $charW) / 2)
  $y0 = [int][math]::Floor(($size - $totalH) / 2)

  # The circle's geometric centre must sit exactly on the glyph centre,
  # otherwise the digit reads as off-centre even when the glyph itself is aligned.
  $cx = $x0 + $charW / 2 - 0.5
  $cy = $y0 + $totalH / 2 - 0.5
  $d = $size - 2
  $sx = $cx - $d / 2
  $sy = $cy - $d / 2
  $brush = New-Object System.Drawing.SolidBrush($red)
  $g.FillEllipse($brush, [float]$sx, [float]$sy, [float]$d, [float]$d)
  $brush.Dispose()
  $g.Dispose()

  $pattern = $glyphs[$label]
  for ($row = 0; $row -lt 7; $row++) {
    $line = $pattern[$row]
    for ($col = 0; $col -lt 5; $col++) {
      if ($line[$col] -ne '1') { continue }
      for ($dy = 0; $dy -lt $dot; $dy++) {
        for ($dx = 0; $dx -lt $dot; $dx++) {
          $px = $x0 + $col * $dot + $dx
          $py = $y0 + $row * $dot + $dy
          if ($px -ge 0 -and $py -ge 0 -and $px -lt $size -and $py -lt $size) {
            $bmp.SetPixel($px, $py, $white)
          }
        }
      }
    }
  }
  return $bmp
}

foreach ($n in 0..9) {
  $bmp = New-Badge 13 1 "$n"
  $bmp.Save((Join-Path $outDir ("b13_$n.png")), [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
  $bmp = New-Badge 26 2 "$n"
  $bmp.Save((Join-Path $outDir ("b26_$n.png")), [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
}
Write-Output ('done: ' + (Get-ChildItem $outDir -Filter 'b13_*.png').Count + ' + ' + (Get-ChildItem $outDir -Filter 'b26_*.png').Count)
