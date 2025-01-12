# Ensure winget is available
if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
    Write-Host "winget is not available. Quitting..."
    exit 1
}

# Install 1Password
winget install AgileBits.1Password -e
winget install AgileBits.1Password.CLI -e

# Prompt user to login to 1Password and enable CLI
$Answer = Read-Host "Please log into 1Password and enable the CLI. Press 'y' when done."

Invoke-Expression $(op signin)
