param(
  [string]$NodeVersionFile = ".nvmrc",
  [Parameter(Mandatory = $true)]
  [string]$Command
)

$ErrorActionPreference = "Stop"

function Get-DesiredNodeVersion {
  param([string]$VersionFile)

  if (-not (Test-Path $VersionFile)) {
    throw "Node version file not found: $VersionFile"
  }

  (Get-Content -Raw $VersionFile).Trim()
}

function Ensure-NvmInstalled {
  if (-not (Get-Command nvm -ErrorAction SilentlyContinue)) {
    throw "nvm was not found. Please install nvm for Windows first."
  }
}

function Ensure-NodeVersionAvailable {
  param([string]$Version)

  $installedVersions = & nvm list | Out-String
  if ($installedVersions -notmatch [regex]::Escape($Version)) {
    Write-Host "Node $Version is not installed yet. Installing with nvm..."
    & nvm install $Version | Out-Host
  }
}

function Set-NodePathFromNvm {
  param([string]$Version)

  $nvmHome = $env:NVM_HOME
  if ([string]::IsNullOrWhiteSpace($nvmHome)) {
    $nvmHome = "C:\Users\$env:USERNAME\AppData\Local\nvm"
  }

  $versionDir = Join-Path $nvmHome "v$Version"
  $nvmSymlink = $env:NVM_SYMLINK
  if ([string]::IsNullOrWhiteSpace($nvmSymlink)) {
    $nvmSymlink = "C:\nvm4w\nodejs"
  }

  $candidatePaths = @($versionDir, $nvmSymlink) | Where-Object { Test-Path $_ }
  foreach ($candidatePath in $candidatePaths) {
    $pathEntries = $env:PATH -split ';' | Where-Object { $_ }
    if ($pathEntries -notcontains $candidatePath) {
      $env:PATH = "$candidatePath;$env:PATH"
    }
  }
}

$desiredVersion = Get-DesiredNodeVersion -VersionFile $NodeVersionFile
Ensure-NvmInstalled
Ensure-NodeVersionAvailable -Version $desiredVersion

Write-Host "Switching to Node $desiredVersion via nvm..."
& nvm use $desiredVersion | Out-Host
Set-NodePathFromNvm -Version $desiredVersion

$nodeVersion = (& node -v).Trim()
Write-Host "Active Node version: $nodeVersion"

if ($nodeVersion -notlike "v$desiredVersion*") {
  throw "Failed to switch to Node $desiredVersion. Current version is $nodeVersion."
}

Write-Host "Running command: $Command"
Invoke-Expression $Command
