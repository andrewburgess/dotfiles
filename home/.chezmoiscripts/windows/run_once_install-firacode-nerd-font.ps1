$userFontsDir = "$env:LOCALAPPDATA\Microsoft\Windows\Fonts"
$existing = Get-ChildItem -Path $userFontsDir -Filter "*FiraCodeNerdFontMono*" -ErrorAction SilentlyContinue

if ($existing) {
    Write-Host "FiraCode Nerd Font Mono already installed, skipping."
    exit 0
}

$tempDir = Join-Path $env:TEMP "FiraCodeNerdFont"
New-Item -ItemType Directory -Force -Path $tempDir | Out-Null

Write-Host "Downloading FiraCode Nerd Font..."
Invoke-WebRequest -Uri "https://github.com/ryanoasis/nerd-fonts/releases/latest/download/FiraCode.zip" -OutFile "$tempDir\FiraCode.zip"

Write-Host "Extracting..."
Expand-Archive -Path "$tempDir\FiraCode.zip" -DestinationPath $tempDir -Force

New-Item -ItemType Directory -Force -Path $userFontsDir | Out-Null
$regPath = "HKCU:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Fonts"

Get-ChildItem -Path $tempDir -Filter "*NerdFontMono*.ttf" -Recurse | ForEach-Object {
    $destPath = Join-Path $userFontsDir $_.Name
    Write-Host "Installing $($_.Name)..."
    Copy-Item $_.FullName $destPath -Force
    Set-ItemProperty -Path $regPath -Name "$($_.BaseName) (TrueType)" -Value $destPath
}

Remove-Item -Recurse -Force $tempDir
Write-Host "FiraCode Nerd Font Mono installed successfully."
