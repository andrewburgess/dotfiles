if (-not (Get-Module -ListAvailable -Name NerdFonts)) {
    Write-Host "Installing NerdFonts PowerShell module from PSGallery..."
    Install-PSResource -Name NerdFonts
}
Import-Module -Name NerdFonts
Install-NerdFont -Name 'FiraCode'
Install-NerdFont -Name 'VictorMono'

# Remove VictorMono italic variants
$fontDirs = @(
    "$env:LOCALAPPDATA\Microsoft\Windows\Fonts",
    "$env:windir\Fonts"
)
foreach ($dir in $fontDirs) {
    Get-ChildItem -Path $dir -Filter "*VictorMono*Italic*" -ErrorAction SilentlyContinue | ForEach-Object {
        Write-Host "Removing italic font: $($_.Name)"
        Remove-Item $_.FullName -Force
    }
}
