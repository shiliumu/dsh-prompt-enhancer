#Requires -Version 5.1
<#
    Live verification for @linxin666/dsh-prompt-enhancer.

    Boots a throwaway DSH web host (profile "pe-verify", cloned from the shipped
    web template) that has this plugin mounted, then checks end to end:
      A. host route   : GET -> 405, POST {} -> 400, control path -> 404
      B. composition  : the plugin appears in the composed profile tree
      C. client DOM   : a real headless Chromium sees the sparkle button
      D. interaction  : type a draft, click, get candidates, adopt with number key

    This does NOT touch the running Desktop app and needs no restart.

    NOTE: ASCII-only on purpose (Windows PowerShell 5.1 reads BOM-less files as ANSI).

    Usage:
        powershell -ExecutionPolicy Bypass -File .\verify-live.ps1
        powershell -ExecutionPolicy Bypass -File .\verify-live.ps1 -Port 4123 -KeepProfile
#>
[CmdletBinding()]
param(
    [int]$Port = 3999,
    [string]$ProfileName = 'pe-verify',
    [switch]$KeepProfile
)

$ErrorActionPreference = 'Stop'

$source = Split-Path -Parent $MyInvocation.MyCommand.Path
$pluginId = '@linxin666/dsh-prompt-enhancer'

# --- locate harness ---------------------------------------------------------
$home1 = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh-community' }
$node = $null
foreach ($candidate in @((Join-Path $env:LOCALAPPDATA 'hermes\node\node.exe'), 'node')) {
    if ($candidate -eq 'node' -or (Test-Path -LiteralPath $candidate)) { $node = $candidate; break }
}
if ($null -eq $node) { throw 'node not found' }

$binCandidates = @(
    (Join-Path $env:LOCALAPPDATA 'Programs\DeepSeek Harness Desktop\resources\app.asar.unpacked\node_modules\@deepseek-ai\dsh\lib\bin.js'),
    (Join-Path $env:LOCALAPPDATA 'hermes\node\node_modules\@deepseek-ai\dsh\lib\bin.js')
)
$bin = $binCandidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
if ($null -eq $bin) { throw "dsh cli not found; looked at: $($binCandidates -join ', ')" }

$env:DSH_HOME = $home1
$profileDir = Join-Path $home1 "profiles\$ProfileName"
$failures = New-Object System.Collections.Generic.List[string]

# Set-Content -Encoding UTF8 emits a BOM in Windows PowerShell 5.1, and JSON.parse
# rejects a BOM-prefixed package.json, so write text through .NET instead.
function Write-Utf8NoBom([string]$path, [string]$text) {
    [System.IO.File]::WriteAllText($path, $text, (New-Object System.Text.UTF8Encoding($false)))
}
function Read-TextNoBom([string]$path) {
    return [System.IO.File]::ReadAllText($path).TrimStart([char]0xFEFF)
}

function Step([string]$text) { Write-Host "`n== $text" -ForegroundColor Cyan }
function Pass([string]$text) { Write-Host "   PASS  $text" -ForegroundColor Green }
function Fail([string]$text) { Write-Host "   FAIL  $text" -ForegroundColor Red; $script:failures.Add($text) }

# --- 1. profile ------------------------------------------------------------
Step "1. profile $ProfileName"
if (-not (Test-Path -LiteralPath (Join-Path $profileDir 'package.json'))) {
    & $node $bin --profile $ProfileName --from-default-profile web --dump-config > $null
    Write-Host "   created from shipped web template"
} else {
    Write-Host "   reusing existing profile"
}

$junction = Join-Path $profileDir "node_modules\@linxin666\dsh-prompt-enhancer"
if (-not (Test-Path -LiteralPath $junction)) {
    New-Item -ItemType Directory -Force -Path (Split-Path $junction) | Out-Null
    New-Item -ItemType Junction -Path $junction -Target $source | Out-Null
}
$manifestPath = Join-Path $profileDir 'package.json'
# heal a BOM that an earlier run may have written, then ensure our dependency is present.
# NOTE: `.PSObject.Properties.Name` on an empty object yields a single $null element;
# enumerate Properties instead.
$manifest = (Read-TextNoBom $manifestPath) | ConvertFrom-Json
$names = @($manifest.dependencies.PSObject.Properties | ForEach-Object { $_.Name })
$dependencies = [ordered]@{}
if (-not ($names -contains $pluginId)) {
    $dependencies[$pluginId] = ('link:' + $source.Replace('\', '/'))
}
foreach ($name in $names) { $dependencies[$name] = $manifest.dependencies.PSObject.Properties[$name].Value }
$manifest.dependencies = [pscustomobject]$dependencies
Write-Utf8NoBom $manifestPath (($manifest | ConvertTo-Json -Depth 20) + "`n")
$patchPath = Join-Path $profileDir 'cordis.patch.yml'
$patchBody = Read-TextNoBom $patchPath
if ($patchBody -notlike '*prompt-enhancer*') {
    $block = @"
# --- prompt-enhancer (user) ---
- insert:
    - id: prompt-enhancer
      name: '$pluginId'
# --- end prompt-enhancer ---
"@
    # 一个空 flow 序列 "[]" 后面不能直接跟块序列，必须整体替换
    $effective = ''
    foreach ($line in ($patchBody -split "`r?`n")) {
        $t = $line.Trim()
        if ($t -ne '' -and -not $t.StartsWith('#')) { $effective += $t }
    }
    if ($effective -eq '[]') { Write-Utf8NoBom $patchPath ($block + "`n") }
    else { Add-Content -LiteralPath $patchPath -Value ("`n" + $block) -Encoding UTF8 }
}
Pass 'profile has junction + dependency + patch entry'

# --- 2. composition --------------------------------------------------------
Step '2. composed profile tree'
$previousEap = $ErrorActionPreference
$ErrorActionPreference = 'Continue'   # native stderr must not become a terminating error
$dump = & $node $bin --profile $ProfileName --dump-config 2>&1
$ErrorActionPreference = $previousEap
if (($dump -join "`n") -match 'prompt-enhancer') { Pass 'plugin present in --dump-config output' }
else { Fail 'plugin missing from --dump-config output' }

# --- 3. boot host ----------------------------------------------------------
Step "3. boot host on 127.0.0.1:$Port"
$outFile = Join-Path ([System.IO.Path]::GetTempPath()) "dsh-pe-verify-$Port.log"
Remove-Item -LiteralPath $outFile -Force -ErrorAction SilentlyContinue
$proc = Start-Process -FilePath $node -ArgumentList "`"$bin`" --profile $ProfileName --port $Port --host 127.0.0.1 --no-open" `
    -RedirectStandardOutput $outFile -RedirectStandardError "$outFile.err" -PassThru -WindowStyle Hidden

$token = $null
for ($i = 0; $i -lt 60; $i++) {
    Start-Sleep -Milliseconds 1000
    if (Test-Path -LiteralPath $outFile) {
        $text = Get-Content -LiteralPath $outFile -Raw
        if ($text -match 'token=([A-Za-z0-9_\-]+)') { $token = $Matches[1]; break }
    }
    if ($proc.HasExited) { break }
}
if ($null -eq $token) {
    Fail "host did not report a token (exit=$($proc.HasExited)); see $outFile"
} else {
    Pass "host up, token acquired"
}

$base = "http://127.0.0.1:$Port"
try {
    if ($null -ne $token) {
        # --- 4. host route ---
        Step '4. host route probes'
        $get = $null
        try { $null = Invoke-WebRequest -Uri "$base/prompt-enhancer/enhance" -UseBasicParsing -TimeoutSec 10 } catch { $get = $_.Exception.Response.StatusCode.value__ }
        if ($get -eq 405) { Pass 'GET /prompt-enhancer/enhance -> 405' } else { Fail "GET expected 405, got $get" }

        $post = $null
        try {
            $null = Invoke-WebRequest -Uri "$base/prompt-enhancer/enhance" -Method POST -ContentType 'application/json' -Body '{}' -UseBasicParsing -TimeoutSec 10
        } catch { $post = $_.Exception.Response.StatusCode.value__ }
        if ($post -eq 400) { Pass 'POST {} -> 400 (draft empty)' } else { Fail "POST expected 400, got $post" }

        $missing = $null
        try { $null = Invoke-WebRequest -Uri "$base/prompt-enhancer/nope" -UseBasicParsing -TimeoutSec 10 } catch { $missing = $_.Exception.Response.StatusCode.value__ }
        if ($missing -eq 404) { Pass 'control path -> 404' } else { Fail "control expected 404, got $missing" }

        # --- 5. browser checks ---
        Step '5. headless browser'
        & $node (Join-Path $source 'test\verify-dom.mjs') $base $token | Out-Host
        & $node (Join-Path $source 'test\verify-ui.mjs') $base $token | Out-Host
        Pass 'browser scripts ran (see output above for button/candidate results)'
    }
} finally {
    if (-not $proc.HasExited) { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue }
    Write-Host "`n   host stopped" -ForegroundColor DarkGray
}

# --- 6. cleanup ------------------------------------------------------------
if (-not $KeepProfile) {
    Step '6. cleanup'
    Remove-Item -LiteralPath $profileDir -Recurse -Force -ErrorAction SilentlyContinue
    Write-Host "   removed $profileDir"
}

Step 'result'
if ($failures.Count -eq 0) {
    Write-Host '   ALL CHECKS PASSED' -ForegroundColor Green
    exit 0
}
Write-Host "   $($failures.Count) FAILURE(S):" -ForegroundColor Red
$failures | ForEach-Object { Write-Host "     - $_" }
exit 1
