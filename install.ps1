#Requires -Version 5.1
<#
    Install @linxin666/dsh-prompt-enhancer into a DSH Desktop profile.

    Steps:
      1. junction the source dir into the profile's node_modules;
      2. append the plugin registration block to the profile's cordis.patch.yml;
      3. register the package in the profile's package.json dependencies
         (the Desktop plugin graph is derived from package.json dependencies);
      4. self-check that the host module imports and resolves @deepseek-ai/dsh-llm.

    NOTE: this file is intentionally ASCII-only. Windows PowerShell 5.1 reads
    BOM-less files as ANSI, which corrupts non-ASCII text.

    Usage (plain PowerShell, no admin needed):
        powershell -ExecutionPolicy Bypass -File .\install.ps1
        powershell -ExecutionPolicy Bypass -File .\install.ps1 -ProfilePath "C:\Users\ROG\.dsh\profiles\desktop"
#>
[CmdletBinding()]
param(
    [string]$ProfilePath = 'C:\Users\ROG\.dsh-community\profiles\desktop'
)

$ErrorActionPreference = 'Stop'

$pluginId = '@linxin666/dsh-prompt-enhancer'
$source = Split-Path -Parent $MyInvocation.MyCommand.Path
$target = Join-Path $ProfilePath 'node_modules\@linxin666\dsh-prompt-enhancer'
$patch = Join-Path $ProfilePath 'cordis.patch.yml'
$manifestPath = Join-Path $ProfilePath 'package.json'
$marker = '# --- prompt-enhancer (user) ---'

# Set-Content -Encoding UTF8 emits a BOM in Windows PowerShell 5.1, and JSON.parse
# rejects a BOM-prefixed package.json, so write JSON through .NET instead.
function Write-Utf8NoBom([string]$path, [string]$text) {
    [System.IO.File]::WriteAllText($path, $text, (New-Object System.Text.UTF8Encoding($false)))
}

Write-Host "== install $pluginId" -ForegroundColor Cyan
Write-Host "source : $source"
Write-Host "profile: $ProfilePath"

if (-not (Test-Path -LiteralPath $ProfilePath)) { throw "profile not found: $ProfilePath" }
if (-not (Test-Path -LiteralPath (Join-Path $source 'lib\client.js'))) { throw "incomplete source: lib\client.js missing" }
if (-not (Test-Path -LiteralPath $patch)) { throw "not found: $patch" }
if (-not (Test-Path -LiteralPath $manifestPath)) { throw "not found: $manifestPath" }

# --- 1/4 junction ------------------------------------------------------------
$scopeDir = Join-Path $ProfilePath 'node_modules\@linxin666'
if (-not (Test-Path -LiteralPath $scopeDir)) { New-Item -ItemType Directory -Force -Path $scopeDir | Out-Null }

if (Test-Path -LiteralPath $target) {
    $item = Get-Item -LiteralPath $target -Force
    if ($item.LinkType -eq 'Junction') {
        Write-Host "[1/4] junction already present: $target -> $($item.Target)" -ForegroundColor Yellow
    } else {
        throw "$target exists and is not a junction; move or delete it manually, then rerun."
    }
} else {
    New-Item -ItemType Junction -Path $target -Target $source | Out-Null
    Write-Host "[1/4] junction created: $target -> $source" -ForegroundColor Green
}

# Host 侧 import 了 @deepseek-ai/dsh-llm，插件自己的 node_modules 里要有它的 junction
# （clone 出来的仓库不带 node_modules，这一步保证可复现）。
$llmLink = Join-Path $source 'node_modules\@deepseek-ai\dsh-llm'
if (-not (Test-Path -LiteralPath $llmLink)) {
    $llmTarget = Join-Path $ProfilePath 'node_modules\@deepseek-ai\dsh-llm'
    if (-not (Test-Path -LiteralPath $llmTarget)) { throw "@deepseek-ai/dsh-llm not found under $ProfilePath\node_modules" }
    New-Item -ItemType Directory -Force -Path (Split-Path $llmLink) | Out-Null
    New-Item -ItemType Junction -Path $llmLink -Target $llmTarget | Out-Null
    Write-Host "[1/4] linked @deepseek-ai/dsh-llm for the host module" -ForegroundColor Green
}

# --- 2/4 cordis.patch.yml ----------------------------------------------------
$content = Get-Content -LiteralPath $patch -Raw
if ($content -like "*$marker*") {
    Write-Host "[2/4] cordis.patch.yml already registered, skipped" -ForegroundColor Yellow
} else {
    $backup = "$patch.bak-prompt-enhancer"
    Copy-Item -LiteralPath $patch -Destination $backup -Force
    $block = @"
$marker
- insert:
    - id: prompt-enhancer
      name: '$pluginId'
# --- end prompt-enhancer ---
"@
    # 一个空 flow 序列 "[]" 后面不能直接跟块序列，必须整体替换
    $effective = ''
    foreach ($line in ($content -split "`r?`n")) {
        $t = $line.Trim()
        if ($t -ne '' -and -not $t.StartsWith('#')) { $effective += $t }
    }
    if ($effective -eq '[]') {
        Write-Utf8NoBom $patch ($block + "`n")
    } else {
        Add-Content -LiteralPath $patch -Value ("`n" + $block) -Encoding UTF8
    }
    Write-Host "[2/4] registered in cordis.patch.yml (backup: $backup)" -ForegroundColor Green
}

# --- 3/4 package.json dependency --------------------------------------------
# NOTE: never enumerate with `.PSObject.Properties.Name` on an empty object: it
# yields a single $null element, and `$obj.$null` then throws.
$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
$names = @($manifest.dependencies.PSObject.Properties | ForEach-Object { $_.Name })
if ($names -contains $pluginId) {
    Write-Host "[3/4] package.json dependency already present, skipped" -ForegroundColor Yellow
} else {
    Copy-Item -LiteralPath $manifestPath -Destination "$manifestPath.bak-prompt-enhancer" -Force
    $linkSpec = 'link:' + $source.Replace('\', '/')
    $dependencies = [ordered]@{}
    $inserted = $false
    foreach ($name in $names) {
        if (-not $inserted -and $name -gt $pluginId) { $dependencies[$pluginId] = $linkSpec; $inserted = $true }
        $dependencies[$name] = $manifest.dependencies.PSObject.Properties[$name].Value
    }
    if (-not $inserted) { $dependencies[$pluginId] = $linkSpec }
    $manifest.dependencies = [pscustomobject]$dependencies
    Write-Utf8NoBom $manifestPath (($manifest | ConvertTo-Json -Depth 20) + "`n")
    Write-Host "[3/4] package.json dependency added: $pluginId -> $linkSpec" -ForegroundColor Green
}

# --- 4/4 host module self-check ---------------------------------------------
$node = $null
foreach ($candidate in @((Join-Path $env:LOCALAPPDATA 'hermes\node\node.exe'), 'node')) {
    if ($candidate -eq 'node' -or (Test-Path -LiteralPath $candidate)) { $node = $candidate; break }
}
if ($null -eq $node) {
    Write-Host "[4/4] node not found, self-check skipped" -ForegroundColor Yellow
} else {
    $entry = 'file:///' + (Join-Path $source 'lib\index.js').Replace('\', '/')
    $tempDir = [System.IO.Path]::GetTempPath()
    if ([string]::IsNullOrEmpty($tempDir)) { $tempDir = $source }
    $checkFile = Join-Path $tempDir 'dsh-prompt-enhancer-selfcheck.mjs'
    @'
const entry = process.argv[2];
const mod = await import(entry);
if (typeof mod.apply !== 'function') {
    console.error('apply missing');
    process.exit(2);
}
console.log('ok:' + mod.name);
'@ | Set-Content -LiteralPath $checkFile -Encoding ASCII
    $check = & $node $checkFile $entry 2>&1
    if ($LASTEXITCODE -ne 0) {
        Write-Host "[4/4] host self-check FAILED:" -ForegroundColor Red
        Write-Host ($check -join "`n")
        Write-Host "hint: make sure $source\node_modules\@deepseek-ai\dsh-llm junction exists." -ForegroundColor Yellow
    } else {
        Write-Host "[4/4] host self-check ok ($check)" -ForegroundColor Green
    }
}

Write-Host ''
Write-Host '== installed, next steps ==' -ForegroundColor Cyan
Write-Host '  1. fully quit and restart DeepSeek Harness Desktop (the profile is not hot-reloaded)'
Write-Host '  2. open any session: a sparkle button appears at the right of the input toolbar'
Write-Host '  3. type a draft, click it (or Ctrl+Shift+Enter) -> candidate box above the input'
Write-Host '     keys: Up/Down switch, 1/2/3 adopt, Enter adopt current, Left/Right regenerate, Esc close'
Write-Host ''
Write-Host 'optional live check without restarting the app:'
Write-Host '  powershell -ExecutionPolicy Bypass -File .\verify-live.ps1'
Write-Host ''
Write-Host 'logs: %APPDATA%\@linxin666\dsh-desktop\logs' -ForegroundColor DarkGray
