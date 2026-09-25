#Requires -Version 5.1
<#
    Uninstall @linxin666/dsh-prompt-enhancer from a DSH Desktop profile:
    removes the junction, the cordis.patch.yml registration block, and the
    package.json dependency entry. The source directory is never touched.

    NOTE: ASCII-only on purpose (Windows PowerShell 5.1 reads BOM-less files as ANSI).

    Usage:
        powershell -ExecutionPolicy Bypass -File .\uninstall.ps1
#>
[CmdletBinding()]
param(
    [string]$ProfilePath = 'C:\Users\ROG\.dsh-community\profiles\desktop'
)

$ErrorActionPreference = 'Stop'

$pluginId = '@linxin666/dsh-prompt-enhancer'
$target = Join-Path $ProfilePath 'node_modules\@linxin666\dsh-prompt-enhancer'
$patch = Join-Path $ProfilePath 'cordis.patch.yml'
$manifestPath = Join-Path $ProfilePath 'package.json'

# Set-Content -Encoding UTF8 emits a BOM in Windows PowerShell 5.1, and JSON.parse
# rejects a BOM-prefixed package.json, so write text through .NET instead.
function Write-Utf8NoBom([string]$path, [string]$text) {
    [System.IO.File]::WriteAllText($path, $text, (New-Object System.Text.UTF8Encoding($false)))
}

# --- 1/3 junction (delete the link only, never the source) -------------------
if (Test-Path -LiteralPath $target) {
    $item = Get-Item -LiteralPath $target -Force
    if ($item.LinkType -eq 'Junction') {
        $item.Delete()
        Write-Host "[1/3] junction removed: $target" -ForegroundColor Green
    } else {
        Write-Host "[1/3] $target is not a junction, skipped" -ForegroundColor Yellow
    }
} else {
    Write-Host "[1/3] junction not present, skipped" -ForegroundColor Yellow
}

# --- 2/3 cordis.patch.yml ---------------------------------------------------
if (Test-Path -LiteralPath $patch) {
    $lines = Get-Content -LiteralPath $patch
    $kept = New-Object System.Collections.Generic.List[string]
    $skipping = $false
    foreach ($line in $lines) {
        if ($line -like '*--- prompt-enhancer (user) ---*') { $skipping = $true; continue }
        if ($line -like '*--- end prompt-enhancer ---*') { $skipping = $false; continue }
        if (-not $skipping) { $kept.Add($line) }
    }
    if ($kept.Count -ne $lines.Count) {
        Copy-Item -LiteralPath $patch -Destination "$patch.bak-prompt-enhancer-uninstall" -Force
        Write-Utf8NoBom $patch (($kept -join "`r`n") + "`r`n")
        Write-Host "[2/3] registration removed from cordis.patch.yml" -ForegroundColor Green
    } else {
        Write-Host "[2/3] no registration block found, skipped" -ForegroundColor Yellow
    }
}

# --- 3/3 package.json dependency -------------------------------------------
if (Test-Path -LiteralPath $manifestPath) {
    $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
    # NOTE: `.PSObject.Properties.Name` on an empty object yields a single $null
    # element; enumerate Properties instead.
    $names = @($manifest.dependencies.PSObject.Properties | ForEach-Object { $_.Name })
    if ($names -contains $pluginId) {
        Copy-Item -LiteralPath $manifestPath -Destination "$manifestPath.bak-prompt-enhancer-uninstall" -Force
        $dependencies = [ordered]@{}
        foreach ($name in $names) {
            if ($name -ne $pluginId) { $dependencies[$name] = $manifest.dependencies.PSObject.Properties[$name].Value }
        }
        $manifest.dependencies = [pscustomobject]$dependencies
        Write-Utf8NoBom $manifestPath (($manifest | ConvertTo-Json -Depth 20) + "`n")
        Write-Host "[3/3] dependency removed from package.json" -ForegroundColor Green
    } else {
        Write-Host "[3/3] no dependency entry found, skipped" -ForegroundColor Yellow
    }
}

Write-Host ''
Write-Host 'uninstall done, restart DeepSeek Harness Desktop to take effect.' -ForegroundColor Cyan
