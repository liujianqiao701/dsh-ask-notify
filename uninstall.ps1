# dsh-ask-notify uninstaller (idempotent).
#
# Removes, in order:
#   1. the LEGACY `- id: ask-notify` insert from the profile's user patch layer
#      (only old installers put one there; activation now lives in the bundle
#      layer, so this step usually has nothing to do)
#   2. the node_modules junction - and only when it really is a junction
#   3. the `link:` dependency line from the profile's package.json
#   4. `dsh-ask-notify` from dsh.profile.bundles
#
# Step 4 is NOT optional. The boot resolves EVERY entry of dsh.profile.bundles
# before it starts, and a listed bundle whose package no longer resolves makes
# `dsh web` refuse to boot with:
#   cannot resolve profile bundle "dsh-ask-notify" from the dsh installation or
#   <profile dir>; run 'dsh plugin --profile web install' ...
# Leaving the entry behind is therefore worse than not uninstalling at all.
#
# The plugin source directory is left alone (delete it by hand if you want it gone).
# A backup of the manifest is kept next to it on every text edit.
# RESTART dsh web afterwards: the bundle layer is read only at startup.
$ErrorActionPreference = 'Stop'

$profile  = Join-Path $env:USERPROFILE '.dsh\profiles\web'
$patch    = Join-Path $profile 'cordis.patch.yml'
$manifest = Join-Path $profile 'package.json'
$link     = Join-Path $profile 'node_modules\dsh-ask-notify'
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)

# 1. legacy user-layer insert -----------------------------------------------
# Structural, not wording-based: this file must stay ASCII-only (no BOM, and
# Windows PowerShell 5.1 would read a BOM-less file as ANSI, turning any
# non-ASCII literal here into mojibake that can never match the patch file).
$lines = [System.IO.File]::ReadAllLines($patch)
$kept = New-Object System.Collections.Generic.List[string]
$i = 0
$removed = 0
while ($i -lt $lines.Count) {
    # an insert block whose body carries `- id: ask-notify`
    if ($lines[$i] -match '^\s*-\s*insert:\s*$') {
        $j = $i + 1
        $hit = $false
        while ($j -lt $lines.Count -and $lines[$j] -match '^\s+\S') {
            if ($lines[$j] -match '^\s*-\s*id:\s*ask-notify\s*$') { $hit = $true }
            $j++
        }
        if ($hit) {
            # drop the contiguous comment block directly above it, when it is
            # about this plugin (older installers appended a few such lines)
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
    Write-Host '[1/4] no legacy user-layer insert - nothing to do here'
} else {
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    Copy-Item $patch "$patch.bak-$stamp" -Force
    [System.IO.File]::WriteAllText($patch, ($kept -join "`r`n") + "`r`n", $utf8NoBom)
    Write-Host "[1/4] removed $removed legacy user-layer insert(s) (backup -> cordis.patch.yml.bak-$stamp)"
}

# 2. junction ---------------------------------------------------------------
if (Test-Path $link) {
    # only remove it when it really is our junction (never delete a real directory)
    $item = Get-Item $link -Force
    if ($item.LinkType -eq 'Junction') {
        [System.IO.Directory]::Delete($link, $false)
        Write-Host '[2/4] junction removed'
    } else {
        Write-Host "[2/4] SKIPPED: $link is not a junction (market install? leave it alone)"
    }
} else {
    Write-Host '[2/4] junction not present'
}

$manifestText = [System.IO.File]::ReadAllText($manifest)
$dirty = $false

# 3. dependency line --------------------------------------------------------
# Scoped to the dependencies object: the name also lives in dsh.profile.bundles,
# so a whole-file match would claim "removed" without touching the dependency.
$depsMatch = [regex]::Match($manifestText, '"dependencies"\s*:\s*\{(?<inner>[^{}]*)\}')
if ($depsMatch.Success -and $depsMatch.Groups['inner'].Value -match '"dsh-ask-notify"\s*:') {
    $manifestText = ([regex]'\s*"dsh-ask-notify"\s*:\s*"[^"]*",?').Replace($manifestText, '', 1)
    $dirty = $true
    Write-Host '[3/4] dependency removed'
} else {
    Write-Host '[3/4] dependency not present'
}

# 4. bundles entry ----------------------------------------------------------
$bundlesMatch = [regex]::Match($manifestText, '"bundles"\s*:\s*\[(?<inner>[^\[\]]*)\]')
if (-not $bundlesMatch.Success) {
    Write-Host '[4/4] WARNING: no "bundles" array in the profile package.json - nothing to remove'
} elseif ($bundlesMatch.Groups['inner'].Value -notmatch '"dsh-ask-notify"') {
    Write-Host '[4/4] dsh.profile.bundles does not list dsh-ask-notify'
} else {
    $inner = $bundlesMatch.Groups['inner'].Value
    # drop it whether it sits last (preceded by a comma) or first/middle
    # (followed by one), then refuse to write anything that stops parsing
    $newInner = [regex]::Replace($inner, '\s*,\s*"dsh-ask-notify"', '')
    if ($newInner -eq $inner) { $newInner = [regex]::Replace($inner, '"dsh-ask-notify"\s*,?\s*', '') }
    $start = $bundlesMatch.Groups['inner'].Index
    $len = $bundlesMatch.Groups['inner'].Length
    $edited = $manifestText.Substring(0, $start) + $newInner + $manifestText.Substring($start + $len)
    $parses = $true
    try { $null = $edited | ConvertFrom-Json } catch { $parses = $false }
    if (-not $parses) {
        Write-Host '[4/4] ERROR: the edited manifest would not parse as JSON - left untouched'
        Write-Host '      -> remove the "dsh-ask-notify" line from dsh.profile.bundles by hand'
    } else {
        $manifestText = $edited
        $dirty = $true
        Write-Host '[4/4] removed dsh-ask-notify from dsh.profile.bundles'
    }
}

if ($dirty) {
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    Copy-Item $manifest "$manifest.bak-$stamp" -Force
    [System.IO.File]::WriteAllText($manifest, $manifestText, $utf8NoBom)
    Write-Host "      manifest written (backup -> package.json.bak-$stamp)"
}

Write-Host ''
Write-Host 'Done. RESTART dsh web (the bundle layer is read only at startup), then refresh'
Write-Host 'the GUI page once to drop the plugin from the running client.'
