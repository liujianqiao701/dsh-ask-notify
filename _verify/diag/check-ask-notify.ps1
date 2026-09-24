#Requires -Version 5.1
<#
  dsh-ask-notify: plugin installed but not working - READ-ONLY diagnostic.
  Nothing is modified. Safe to run any number of times.

  HOW TO RUN
    Double-click check-ask-notify.cmd  (easiest)
    or: powershell -ExecutionPolicy Bypass -File check-ask-notify.ps1

  OPTIONS
    -Port 3080          your DSH port, if you know it; otherwise it scans
    -ScanFrom/-ScanTo   port range to scan (default 3070..3099)

  ORDER
    Part A reads the disk only (no network, so a 401 / auth gate cannot break it).
    Part B finds the DSH web server.
    Part C asks that server what it is actually serving.

  Output is ASCII only on purpose (Windows PowerShell 5.1 decodes BOM-less
  UTF-8 files as ANSI, which turns non-ASCII output into mojibake).
  Send the whole output back to the author.
#>
param(
  [int]$Port = 0,
  [int]$ScanFrom = 3070,
  [int]$ScanTo = 3099,
  [switch]$SkipScan
)

$ErrorActionPreference = 'Continue'
$profDir = Join-Path $env:USERPROFILE '.dsh\profiles'

# Everything printed below is also written into this report file, so the result
# can be sent back AS A FILE instead of being copy-pasted out of the console.
$report = Join-Path $PSScriptRoot 'dsh-ask-notify-report.txt'
$transcriptOn = $false
try {
  if (Test-Path $report) { Remove-Item $report -Force -ErrorAction SilentlyContinue }
  Start-Transcript -Path $report -Force | Out-Null
  $transcriptOn = $true
} catch {
  $transcriptOn = $false
}

Write-Host ''
Write-Host '=== A. DISK SIDE (no network, not affected by 401 / auth gates) ==='
Write-Host ('1) profiles root: {0}' -f $profDir)

$profiles = @()
if (Test-Path $profDir) {
  $profiles = @(Get-ChildItem $profDir -Directory -Force |
    Where-Object { $_.Name -ne 'node_modules' } |
    ForEach-Object { $_.Name })
}
Write-Host ('2) profiles found: {0}' -f $(if ($profiles.Count -gt 0) { ($profiles -join ', ') } else { '(none - has dsh web ever run on this account?)' }))

$found = @()
foreach ($name in $profiles) {
  $dir = Join-Path $profDir $name
  $pkg = Join-Path $dir 'node_modules\dsh-ask-notify\package.json'
  $cli = Join-Path $dir 'node_modules\dsh-ask-notify\lib\client.js'
  $man = Join-Path $dir 'package.json'
  $reg = @()
  if (Test-Path $man) { $reg = @(Select-String -Path $man -Pattern 'dsh-ask-notify' -SimpleMatch | ForEach-Object { $_.Line.Trim() }) }
  $hasPkg = Test-Path $pkg
  $hasCli = Test-Path $cli
  if ($hasPkg -or $hasCli -or $reg.Count -gt 0) { $found += $name }
  Write-Host ('   [{0}] package={1}  client.js={2}  manifest-hits={3}' -f $name, $hasPkg, $hasCli, $reg.Count)
  $reg | ForEach-Object { Write-Host ('       {0}' -f $_) }
  if ($hasPkg -or $hasCli) {
    $hot = Join-Path $dir '.dsh-market'
    Write-Host ('       market hot-mount dir: {0}' -f $(if (Test-Path $hot) { (@(Get-ChildItem $hot -Force | ForEach-Object { $_.Name }) -join ', ') } else { '(absent)' }))
  }
}
Write-Host ('3) profiles carrying dsh-ask-notify: {0}' -f $(if ($found.Count -gt 0) { ($found -join ', ') } else { '(none - the install never landed on disk)' }))

# --- B. find the DSH web server -----------------------------------------------
Write-Host ''
Write-Host '=== B. FIND THE DSH WEB SERVER ==='

function Test-PortOpen([int]$p, [int]$ms = 150) {
  $c = New-Object System.Net.Sockets.TcpClient
  try {
    $iar = $c.BeginConnect('127.0.0.1', $p, $null, $null)
    if (-not $iar.AsyncWaitHandle.WaitOne($ms)) { return $false }
    $c.EndConnect($iar)
    return $true
  } catch {
    return $false
  } finally {
    $c.Close()
  }
}

function Get-PortProbe([int]$p) {
  $u = "http://127.0.0.1:$p/"
  try {
    $r = Invoke-WebRequest -UseBasicParsing $u -TimeoutSec 2
  } catch {
    $resp = $_.Exception.Response
    if ($resp -ne $null) { return @{ kind = "HTTP $([int]$resp.StatusCode)"; html = $null } }
    return @{ kind = 'no-answer'; html = $null }
  }
  return @{ kind = "HTTP $($r.StatusCode)"; html = $r.Content }
}

function Test-IsDsh($probe) {
  if ($probe.html -eq $null) { return $false }
  return ($probe.html -match '__DSH_BOOT__') -or ($probe.html -match '/plugins/') -or ($probe.html -match 'DeepSeek Harness')
}

$dshPort = 0
$html = $null
$notes = @()
$authPorts = @()

# 3080 first (the default), then upward, then whatever is below the default.
$candidates = @()
if ($Port -gt 0) { $candidates += $Port }
if (-not $SkipScan) {
  $candidates += 3080
  $candidates += @(3081..$ScanTo)
  $candidates += @($ScanFrom..3079)
}
$candidates = @($candidates | Where-Object { $_ -gt 0 } | Select-Object -Unique)

Write-Host ('4) probing {0} candidate ports on 127.0.0.1 (3080 first) ...' -f $candidates.Count)
foreach ($p in $candidates) {
  if (-not (Test-PortOpen $p)) { continue }
  $pr = Get-PortProbe $p
  if (Test-IsDsh $pr) { $dshPort = $p; $html = $pr.html; break }
  if ($pr.kind -eq 'HTTP 401' -or $pr.kind -eq 'HTTP 403') {
    # An authenticated server: the browser carries a cookie, PowerShell cannot.
    # This is very likely the DSH GUI itself, so record it instead of calling it "not DSH".
    $authPorts += $p
    $notes += ('   port {0} is open -> {1}: the server DEMANDS AUTH. A browser has the cookie, a plain script does not.' -f $p, $pr.kind)
    $notes += ('      -> if you opened the GUI at http://127.0.0.1:{0}/ then this IS your DSH, behind an auth gate.' -f $p)
  } else {
    $notes += ('   port {0} is open -> {1} (NOT the DSH GUI; a real DSH root returns HTML containing __DSH_BOOT__)' -f $p, $pr.kind)
  }
}

$notes | Select-Object -First 12 | ForEach-Object { Write-Host $_ }

if ($dshPort -eq 0) {
  if ($authPorts.Count -gt 0) {
    Write-Host ('5) DSH GUI: reached only through an AUTH GATE on port(s) {0} - this script cannot log in.' -f ($authPorts -join ', '))
  } else {
    Write-Host ('5) DSH GUI: NOT FOUND on 127.0.0.1 in {0}..{1}' -f $ScanFrom, $ScanTo)
  }
} else {
  Write-Host ('5) DSH GUI found at http://127.0.0.1:{0}' -f $dshPort)
}

# --- C. what the server is actually serving -----------------------------------
$hit = @()
if ($dshPort -gt 0) {
  Write-Host ''
  Write-Host '=== C. WHAT THAT SERVER IS SERVING ==='
  $urls = [regex]::Matches($html, '/plugins/[^"]*?client\.js') | ForEach-Object { $_.Value } | Sort-Object -Unique
  Write-Host ('6) plugin entries in the boot payload: {0}   (a healthy install lists 40+)' -f $urls.Count)
  Write-Host ('7) market (dshmarket) in payload: {0}' -f $(if ($urls -match 'dshmarket') { 'YES -> this is the right dsh instance' } else { 'NO  -> you are looking at another instance' }))
  $hit = @($urls | Where-Object { $_ -match 'ask-notify' })
  Write-Host ('8) dsh-ask-notify in payload: {0}' -f $(if ($hit.Count -gt 0) { 'YES -> the server IS serving it (a page refresh is enough)' } else { 'NO  -> the running process has no live entry for it' }))
  $hit | ForEach-Object { Write-Host ('   {0}' -f $_) }
}

# --- D. the market's own log (its own record of what happened) -----------------
Write-Host ''
Write-Host '=== D. MARKET OWN LOG (what the market itself recorded about this install) ==='
if ($found.Count -eq 0) {
  Write-Host '9) skipped - no profile carries dsh-ask-notify'
} else {
  foreach ($name in $found) {
    $hot = Join-Path (Join-Path $profDir $name) '.dsh-market'
    if (-not (Test-Path $hot)) { continue }
    Write-Host ('9) [{0}] {1}' -f $name, $hot)

    $log = Join-Path $hot 'log.ndjson'
    if (Test-Path $log) {
      $tail = @(Get-Content $log -Encoding UTF8 -Tail 30)
      Write-Host '   --- log.ndjson (last 30 lines) ---'
      $tail | ForEach-Object { Write-Host ('   ' + $_) }
      $dump = Join-Path $env:TEMP 'dsh-ask-notify-market-log.txt'
      try {
        Set-Content -Path $dump -Value $tail -Encoding UTF8
        Write-Host ('   --- a UTF-8 copy is saved at: {0} (send that file if the text above looks garbled) ---' -f $dump)
      } catch { }
    } else {
      Write-Host '   no log.ndjson here'
    }
    $state = Join-Path $hot 'state.json'
    if (Test-Path $state) { Write-Host ('10) state.json: ' + (Get-Content $state -Raw -Encoding UTF8).Trim()) }

    $disc = Join-Path $hot 'discovery-compatibility-v1.json'
    if (Test-Path $disc) {
      $t = ((Get-Content $disc -Raw -Encoding UTF8) -replace '\s+', ' ').Trim()
      if ($t.Length -gt 600) { $t = $t.Substring(0, 600) + ' ...[truncated]' }
      Write-Host ('11) discovery-compatibility-v1.json: ' + $t)
    }
  }
}

# --- E. running harness (the generation decides where the pending state lives) ---
Write-Host ''
Write-Host '=== E. RUNNING HARNESS (version matters) ==='
Write-Host '    Two harness generations are in the wild and they expose the pending state'
Write-Host '    differently: up to 0.1.1-rc.x it sits on the session-list row, and from'
Write-Host '    0.1.2+ a ui-session service publishes it instead. dsh-ask-notify 1.0.4+'
Write-Host '    reads EVERY known shape by name (three generations), and when none of them'
Write-Host '    answers it auto-detects any map-like member that is holding waits, so a'
Write-Host '    renamed source is picked up without a new release. Builds up to 1.0.1 pinned'
Write-Host '    @deepseek-ai/dsh-client-runtime in dsh.client.inject, and that package does'
Write-Host '    not exist in newer harnesses - which made the client half never mount,'
Write-Host '    silently. The lines below tell you which generation is running.'

$harnessRoots = @()
$procLines = @()
try {
  $procs = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and $_.CommandLine -match 'dsh' })
  foreach ($p in $procs) {
    $cl = $p.CommandLine
    if ($cl.Length -gt 300) { $cl = $cl.Substring(0, 300) + ' ...' }
    $procLines += $cl
    # Locate <...>\node_modules next to @deepseek-ai\dsh\lib\ , tolerating the
    # node_modules\.bin\.. form that npx uses.
    $k = $p.CommandLine.IndexOf('@deepseek-ai\dsh\lib\')
    if ($k -lt 0) { $k = $p.CommandLine.IndexOf('@deepseek-ai/dsh/lib/') }
    if ($k -gt 0) {
      $head = $p.CommandLine.Substring(0, $k)
      # drop any leading quoting / launcher noise, keep from the drive letter on
      $di = [regex]::Match($head, '[A-Za-z]:\\').Index
      if ($di -ge 0) { $head = $head.Substring($di) }
      $nm = $head.LastIndexOf('node_modules')
      if ($nm -gt 0) {
        $root = $head.Substring(0, $nm + 'node_modules'.Length)
        if ($harnessRoots -notcontains $root) { $harnessRoots += $root }
      }
    }
  }
} catch { }

if ($procLines.Count -eq 0) {
  Write-Host '12) no running node process mentions dsh (is dsh web running right now?)'
} else {
  Write-Host ('12) running dsh processes: {0}' -f $procLines.Count)
  $procLines | Select-Object -First 3 | ForEach-Object { Write-Host ('    ' + $_) }
}

if ($harnessRoots.Count -eq 0) {
  Write-Host '13) harness node_modules: NOT identified from the process list'
  # Targeted fallback: the npx cache keeps one folder per cached package.
  $npx = Join-Path $env:LOCALAPPDATA 'npm-cache\_npx'
  if (Test-Path $npx) {
    foreach ($c in @(Get-ChildItem $npx -Directory -ErrorAction SilentlyContinue)) {
      $cand = Join-Path $c.FullName 'node_modules'
      if (Test-Path (Join-Path $cand '@deepseek-ai\dsh\package.json')) {
        Write-Host ('    npx cache candidate: {0}' -f $cand)
        $harnessRoots += $cand
      }
    }
  }
  if ($harnessRoots.Count -eq 0) { Write-Host '    no npx-cached harness found either' }
} else {
  foreach ($root in $harnessRoots) {
    $dshPkg = Join-Path $root '@deepseek-ai\dsh\package.json'
    $ver = '(unknown)'
    if (Test-Path $dshPkg) {
      try { $ver = (Get-Content $dshPkg -Raw -Encoding UTF8 | ConvertFrom-Json).version } catch { }
    }
    $rt = Test-Path (Join-Path $root '@deepseek-ai\dsh-client-runtime')
    $uis = Test-Path (Join-Path $root '@deepseek-ai\dsh-client-ui-session')
    $cmod = Test-Path (Join-Path $root '@deepseek-ai\dsh-client-modules')
    Write-Host ('13) harness: {0}' -f $root)
    Write-Host ('    @deepseek-ai/dsh version        : {0}' -f $ver)
    Write-Host ('    dsh-client-ui-session present   : {0}   <- True = NEW generation (pending state via uiSession)' -f $uis)
    Write-Host ('    dsh-client-runtime    present   : {0}   <- True = OLD generation (pending state on the list row)' -f $rt)
    Write-Host '                                      1.0.4+ reads every shape it knows and auto-detects the rest; builds <= 1.0.1 needed the runtime one'
    Write-Host ('    dsh-client-modules  present   : {0}   <- serves /plugins/<pkg>/client.js' -f $cmod)
  }
}

# --- F. the installed plugin package on disk ----------------------------------
Write-Host ''
Write-Host '=== F. INSTALLED PLUGIN PACKAGE ON DISK ==='
if ($found.Count -eq 0) {
  Write-Host '14) skipped - nothing installed'
} else {
  foreach ($name in $found) {
    $dir = Join-Path (Join-Path $profDir $name) 'node_modules\dsh-ask-notify'
    if (-not (Test-Path $dir)) { continue }
    Write-Host ('14) [{0}] {1}' -f $name, $dir)
    Get-ChildItem $dir -Recurse -File -ErrorAction SilentlyContinue | ForEach-Object {
      Write-Host ('    {0,8}  {1}' -f $_.Length, $_.FullName.Substring($dir.Length + 1))
    }

    $patch = Join-Path $dir 'cordis.patch.yml'
    if (Test-Path $patch) {
      Write-Host '    --- bundled cordis.patch.yml (this is what the bundle layer inserts) ---'
      Get-Content $patch -Encoding UTF8 | ForEach-Object { Write-Host ('    | ' + $_) }
    } else {
      Write-Host '    !!! cordis.patch.yml is MISSING from the installed copy.'
      Write-Host '    !!! Without it the bundle layer has nothing to insert -> the entry never mounts.'
    }

    $man = Join-Path (Join-Path $profDir $name) 'package.json'
    if (Test-Path $man) {
      Write-Host '    --- profile manifest: dependencies + dsh.profile.bundles ---'
      try {
        $j = Get-Content $man -Raw -Encoding UTF8 | ConvertFrom-Json
        $dep = $j.dependencies.'dsh-ask-notify'
        Write-Host ('    dependencies["dsh-ask-notify"] = {0}' -f $(if ($dep) { $dep } else { '(absent)' }))
        $b = @($j.dsh.profile.bundles)
        Write-Host ('    dsh.profile.bundles = [{0}]' -f ($b -join ', '))
        Write-Host ('      -> dsh-ask-notify in bundles: {0}' -f ($b -contains 'dsh-ask-notify'))
      } catch {
        Write-Host '    (could not parse package.json)'
      }
      Write-Host '    --- user patch layer: any leftover ask-notify insert here? ---'
      $up = Join-Path (Join-Path $profDir $name) 'cordis.patch.yml'
      if (Test-Path $up) {
        $hits = @(Select-String -Path $up -Pattern 'ask-notify' -SimpleMatch -Encoding UTF8 |
          Where-Object { -not $_.Line.TrimStart().StartsWith('#') })
        if ($hits.Count -eq 0) {
          Write-Host '    none active (good - the bundle layer must be the only place that inserts it)'
        } else {
          $hits | ForEach-Object { Write-Host ('    {0}: {1}' -f $_.LineNumber, $_.Line.Trim()) }
          Write-Host '    ^ a live insert here PLUS the bundle layer = duplicate id = boot failure'
        }
      }
    }
  }
}

# --- conclusion ---------------------------------------------------------------
Write-Host ''
if ($hit.Count -gt 0) {
  Write-Host ('CONCLUSION: the SERVER side is fine (port {0}).' -f $dshPort)
  Write-Host '            Open the GUI on THAT port and refresh: F5, or Ctrl+F5. No restart needed.'
} elseif ($dshPort -eq 0 -and $authPorts.Count -gt 0) {
  Write-Host ('CONCLUSION: your DSH sits behind an AUTH GATE on port {0}; this script cannot read the boot payload.' -f ($authPorts -join ', '))
  Write-Host '            Do these two checks in the BROWSER (it is already logged in):'
  Write-Host ('              a) http://127.0.0.1:{0}/  then Ctrl+U and Ctrl+F for "ask-notify"' -f $authPorts[0])
  Write-Host '                 found     -> the server DOES ship the entry: just press F5, no restart needed'
  Write-Host '                 not found -> the running process has not composed it: restart dsh web, then Ctrl+F5'
  Write-Host '              b) F12 -> Console, then type: __dshAskNotify.sources()'
  Write-Host '                 used:"uiSession.status" / "uiSession.pending" / "list" / any name'
  Write-Host '                 listed under discovered:"..." = reading the wait state;'
  Write-Host '                 used:"none" = no readable source at all (the plugin cannot fire)'
  Write-Host '              NOTE: do NOT judge this by hand-typing /plugins/dsh-ask-notify/client.js.'
  Write-Host '                    Newer harnesses key that route by ?rev=..., so a hand-typed URL 404s'
  Write-Host '                    BY DESIGN even when everything works. Ctrl+U above is the reliable check.'
  if ($found.Count -gt 0) {
    Write-Host ('            Part A says the plugin IS installed (profile: {0}), so a restart is the expected fix.' -f ($found -join ', '))
    Write-Host '            And part D below is the market own record of whether it hot-mounted or asked for a restart.'
  }
} elseif ($dshPort -eq 0) {
  Write-Host 'CONCLUSION: could not find the DSH GUI on 127.0.0.1 in that port range.'
  Write-Host '            Read the port from the browser address bar where the GUI is open, then re-run:'
  Write-Host '              check-ask-notify.cmd -Port <that port>'
  Write-Host '            If part A looks fine, the plugin is installed in another profile, or the GUI runs on another machine.'
} elseif ($found.Count -gt 0) {
  Write-Host ('CONCLUSION: installed on disk (profile: {0}) but NOT MOUNTED in the running process.' -f ($found -join ', '))
  Write-Host '            Fully exit dsh (close the window / terminal that runs it), start "dsh web" again,'
  Write-Host '            then open the GUI on that same port and press Ctrl+F5. This always fixes this case.'
} else {
  Write-Host 'CONCLUSION: the install never landed - no files and no manifest entry in any profile.'
  Write-Host '            Re-install from the market after stopping every running agent.'
  Write-Host '            (the market refuses with "an agent is currently working" if one is running)'
}
Write-Host ''

Write-Host '=== REPORT FILE (send this file back instead of copy-pasting the console) ==='
if ($transcriptOn) {
  Write-Host ('   {0}' -f $report)
  Write-Host '   That file already contains every line above.'
  try { Stop-Transcript | Out-Null } catch { }
} else {
  Write-Host '   (transcript unavailable in this host - please copy the console text instead)'
}
Write-Host ''
