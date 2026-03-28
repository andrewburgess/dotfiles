if (-not (Get-Module -ListAvailable -Name NerdFonts)) {
    Write-Host "Installing NerdFonts PowerShell module from PSGallery..."
    Install-PSResource -Name NerdFonts
}
Import-Module -Name NerdFonts
Install-NerdFont -Name 'FiraCode'
