# dsh-ask-notify installer (idempotent).
#
#   1. junction  : ~\.dsh\profiles\web\node_modules\dsh-ask-notify -> this source dir
#   2. cleanup   : drop the LEGACY `- id: ask-notify` insert from the profile's
#                  user patch layer. Activation now happens in the *bundle*
#                  layer: this package ships its own cordis.patch.yml carrying
#                  the insert, and that layer is composed from
#                  package.json -> dsh.profile.bundles. A second insert in the
#                  user layer mounts the same id twice and `dsh web` refuses to
#                  boot with "duplicate loader entry id: ask-notify".
#   3. dependency: a `link:` entry in the profile's package.json, so a later
#                  `pnpm install` (the plugin market runs one) cannot prune the
#                  junction and leave the bundle entry unresolvable
#   4. bundles   : register `dsh-ask-notify` in dsh.profile.bundles. THIS is the
#                  activation point. `dsh plugin ...` reconciles that list by
#                  itself (it runs after pnpm), but a junction install does not -
#                  and `dsh web` never reconciles either. Without this step the
#                  package sits installed and nothing ever mounts it, no matter
#                  how often you restart.
#
# Re-run any time. Then RESTART dsh web and refresh the GUI page once: the bundle
# layer is only read at startup.
#
# Text edits are byte-level (no JSON re-serialization, no BOM) so the profile
# manifest keeps its own formatting and stays parseable by pnpm.
param([string]$SourceDir = '')
$ErrorActionPreference = 'Stop'

# Where the plugin source is. Defaults to the folder THIS script sits in, so a
# colleague who cloned the repository can run it as-is; the absolute path is
# only the fallback for the author's own tree. Override: -SourceDir <path>
$src = $SourceDir
if ($src -eq '') {
    if ($PSScriptRoot -and (Test-Path (Join-Path $PSScriptRoot 'package.json'))) {
        $src = $PSScriptRoot
    } else {
        $src = 'D:\playwright-AI\playwright\dsh-ask-notify'
    }
}
$profile  = Join-Path $env:USERPROFILE '.dsh\profiles\web'
$patch    = Join-Path $profile 'cordis.patch.yml'
$manifest = Join-Path $profile 'package.json'
$link     = Join-Path $profile 'node_modules\dsh-ask-notify'
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)

if (-not (Test-Path $src)) { throw "plugin source not found: $src" }
if (-not (Test-Path $profile)) { throw "profile not found: $profile" }

# 1. junction ---------------------------------------------------------------
if (Test-Path (Join-Path $link 'package.json')) {
    Write-Host '[1/4] junction already present'
} else {
    if (Test-Path $link) { Remove-Item $link -Recurse -Force }
    cmd /c mklink /J "$link" "$src" | Out-Null
    if (-not (Test-Path (Join-Path $link 'package.json'))) { throw "junction created but unreadable: $link" }
    Write-Host '[1/4] junction created'
}

# 2. legacy user-layer insert cleanup ---------------------------------------
# Activation now lives in the bundle layer (package.json -> dsh.profile.bundles
# plus the package's own cordis.patch.yml). A second insert with the same id in
# the user layer mounts it twice and `dsh web` aborts at boot with
# "duplicate loader entry id: ask-notify" - so this step only removes, never adds.
# NOTE: keep this file ASCII-only. It has no BOM, and Windows PowerShell 5.1
# decodes BOM-less files as ANSI, which turns non-ASCII comments into mojibake
# that can break parsing.
$lines = [System.IO.File]::ReadAllLines($patch)
$kept = New-Object System.Collections.Generic.List[string]
$i = 0
$removed = 0
while ($i -lt $lines.Count) {
    # find the insert block that carries ask-notify, drop it through its end
    if ($lines[$i] -match '^\s*-\s*insert:\s*$') {
        $j = $i + 1
        $hit = $false
        while ($j -lt $lines.Count -and $lines[$j] -match '^\s+\S') {
            if ($lines[$j] -match '^\s*-\s*id:\s*ask-notify\s*$') { $hit = $true }
            $j++
        }
        if ($hit) {
            # drop the whole comment block directly above it, if that block is
            # about ask-notify (the legacy installer appended three such lines)
            $runStart = $kept.Count
            while ($runStart -gt 0 -and $kept[$runStart - 1] -match '^\s*#') { $runStart-- }
            $aboutNotify = $false
            for ($k = $runStart; $k -lt $kept.Count; $k++) {
                if ($kept[$k] -match 'ask-notify') { $aboutNotify = $true }
            }
            if ($aboutNotify) {
                while ($kept.Count -gt $runStart) { $kept.RemoveAt($kept.Count - 1) }
            }
            $i = $j
            $removed++
            continue
        }
    }
    $kept.Add($lines[$i])
    $i++
}
if ($removed -eq 0) {
    Write-Host '[2/4] no legacy user-layer insert - activation comes from the bundle layer'
} else {
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    Copy-Item $patch "$patch.bak-$stamp" -Force
    Write-Host "[2/4] backup -> cordis.patch.yml.bak-$stamp"
    [System.IO.File]::WriteAllText($patch, ($kept -join "`r`n") + "`r`n", $utf8NoBom)
    Write-Host "[2/4] removed $removed legacy user-layer insert(s) - activation now from the bundle layer"
}

# 3. dependency registration ------------------------------------------------
$manifestText = [System.IO.File]::ReadAllText($manifest)
# Scope the check to the dependencies object: the name also appears in
# dsh.profile.bundles, so a whole-file match would wrongly report "already
# registered" and skip the link: entry that keeps the junction from being pruned.
$depsMatch = [regex]::Match($manifestText, '"dependencies"\s*:\s*\{(?<inner>[^{}]*)\}')
$depRegistered = $depsMatch.Success -and ($depsMatch.Groups['inner'].Value -match '"dsh-ask-notify"\s*:')
if ($depRegistered) {
    Write-Host '[3/4] dependency already registered'
} else {
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    Copy-Item $manifest "$manifest.bak-$stamp" -Force
    $spec = 'link:' + ($src -replace '\\', '/')
    $line = '    "dsh-ask-notify": "' + $spec + '",'
    $anchor = [regex]'("dsh-file-drop"\s*:\s*"[^"]*",)'
    if ($anchor.IsMatch($manifestText)) {
        $manifestText = $anchor.Replace($manifestText, "`$1`r`n$line", 1)
    } else {
        $manifestText = ([regex]'("dependencies"\s*:\s*\{)').Replace($manifestText, "`$1`r`n$line", 1)
    }
    [System.IO.File]::WriteAllText($manifest, $manifestText, $utf8NoBom)
    Write-Host "[3/4] dependency registered: dsh-ask-notify = $spec (backup kept)"
}

# 4. bundle layer registration ----------------------------------------------
# The boot composes its patch layers from `dsh.profile.bundles`, and this
# package's own cordis.patch.yml supplies the insert. `dsh plugin ...`
# reconciles that list after pnpm, but this installer never goes through pnpm -
# and `dsh web` never reconciles either. So register the entry here,
# byte-level and idempotently, refusing to write anything that would no longer
# parse as JSON.
$bundlesMatch = [regex]::Match($manifestText, '"bundles"\s*:\s*\[(?<inner>[^\[\]]*)\]')
if (-not $bundlesMatch.Success) {
    Write-Host '[4/4] WARNING: no "bundles" array in the profile package.json'
    Write-Host '      -> add "dsh-ask-notify" to dsh.profile.bundles by hand, or install from the plugin market'
} elseif ($bundlesMatch.Groups['inner'].Value -match '"dsh-ask-notify"') {
    Write-Host '[4/4] dsh.profile.bundles already contains dsh-ask-notify'
} else {
    $inner = $bundlesMatch.Groups['inner'].Value
    $tail = $inner.TrimEnd()
    if ($tail.Trim() -eq '') {
        $newInner = "`r`n        `"dsh-ask-notify`"`r`n      "
    } else {
        $newInner = $tail + ",`r`n        `"dsh-ask-notify`"`r`n      "
    }
    $start = $bundlesMatch.Groups['inner'].Index
    $len = $bundlesMatch.Groups['inner'].Length
    $edited = $manifestText.Substring(0, $start) + $newInner + $manifestText.Substring($start + $len)
    $parses = $true
    try { $null = $edited | ConvertFrom-Json } catch { $parses = $false }
    if (-not $parses) {
        Write-Host '[4/4] ERROR: the edited manifest would not parse as JSON - nothing written'
        Write-Host '      -> install from the plugin market instead'
    } else {
        $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
        Copy-Item $manifest "$manifest.bak-$stamp" -Force
        [System.IO.File]::WriteAllText($manifest, $edited, $utf8NoBom)
        Write-Host '[4/4] registered dsh-ask-notify in dsh.profile.bundles (backup kept)'
    }
}

Write-Host ''
Write-Host 'Done. Now RESTART dsh web (the bundle layer is read only at startup), then'
Write-Host 'refresh the DSH GUI page once (F5) - the entry must show up in the boot payload.'
Write-Host 'Self-test in the page console:  __dshAskNotify.selftest()'
