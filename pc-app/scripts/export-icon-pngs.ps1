$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.Drawing



$root = Split-Path -Parent $PSScriptRoot

$pngPath = Join-Path $root 'assets\Copilot_20260522_174446.png'

$assets = Join-Path $root 'assets'

$mobile = Join-Path $root 'mobile'



if (-not (Test-Path $pngPath)) {

  throw "Logo not found: $pngPath"

}



function Export-SquareIcon($src, $size, $outPath) {

  $bmp = New-Object System.Drawing.Bitmap($size, $size)

  try {

    $g = [System.Drawing.Graphics]::FromImage($bmp)

    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic

    $g.Clear([System.Drawing.Color]::FromArgb(0, 0, 0))

    $g.DrawImage($src, 0, 0, $size, $size)

    $g.Dispose()

    $bmp.Save($outPath, [System.Drawing.Imaging.ImageFormat]::Png)

  }

  finally {

    $bmp.Dispose()

  }

}



$src = [System.Drawing.Image]::FromFile($pngPath)

try {

  $assetSizes = @(16, 32, 48, 180, 256, 512, 1024)

  foreach ($size in $assetSizes) {

    Export-SquareIcon $src $size (Join-Path $assets "icon-$size.png")

  }



  $mobileSizes = @(32, 48, 180, 192, 512)

  foreach ($size in $mobileSizes) {

    Export-SquareIcon $src $size (Join-Path $mobile "icon-$size.png")

  }



  Export-SquareIcon $src 180 (Join-Path $mobile 'apple-touch-icon.png')



  $icoSrc = Join-Path $assets 'icon.ico'

  if (Test-Path $icoSrc) {

    Copy-Item $icoSrc (Join-Path $mobile 'favicon.ico') -Force

    Copy-Item $icoSrc (Join-Path $mobile 'icon.ico') -Force

  }

}

finally {

  $src.Dispose()

}



Write-Host 'Exported assets + mobile PWA icons (apple-touch 180, manifest 192/512)'

