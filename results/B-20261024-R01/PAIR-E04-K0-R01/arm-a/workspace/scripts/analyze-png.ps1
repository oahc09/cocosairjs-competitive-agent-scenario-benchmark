param([string]$Path)
Add-Type -AssemblyName System.Drawing
$b = [System.Drawing.Bitmap]::new($Path)
$W = $b.Width; $H = $b.Height
function Stat([double]$y0, [double]$y1) {
  $ys = [int][math]::Floor($y0 * $H); $ye = [int][math]::Ceiling($y1 * $H)
  $n = 0; $sum = 0.0; $warm = 0
  for ($y = $ys; $y -lt $ye; $y += 2) {
    for ($x = 0; $x -lt $W; $x += 2) {
      $p = $b.GetPixel($x, $y)
      $n++
      $sum += ($p.R * 0.2126 + $p.G * 0.7152 + $p.B * 0.0722)
      if ($p.R -gt 120 -and $p.R -gt $p.G * 1.12 -and $p.G -gt $p.B * 1.08) { $warm++ }
    }
  }
  $warmFull = [int]($warm * 4)
  Write-Output ("  y[" + $y0 + "," + $y1 + "] meanLuma=" + [math]::Round($sum / $n, 2) + " warmFull=" + $warmFull)
}
Write-Output ("FILE " + (Split-Path $Path -Leaf) + " " + $W + "x" + $H)
Stat 0.55 0.65
Stat 0.667 1.0
Stat 0.70 0.80
Stat 0.80 0.90
Stat 0.90 1.0
Stat 0.0 0.5
$b.Dispose()
