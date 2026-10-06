# start-portal.ps1 - One-click launcher for the benchmark report portal
# (Reference gallery / batch runs / reports / gates)
# Behavior: stop any OLD portal instance listening on the target port,
#           start a FRESH instance via the repo's official entry (run.mjs portal),
#           wait until it responds, then open the default browser.
# Usage:    .\start-portal.ps1            # default port 7800
#           .\start-portal.ps1 -Port 7801 # custom port
# ASCII-only on purpose: stays readable under any Windows codepage.

param([int]$Port = 7800)

$ErrorActionPreference = 'Stop'
$here   = Split-Path -Parent $MyInvocation.MyCommand.Path   # ...\results
$root   = Split-Path -Parent $here                          # repo root
$runner = Join-Path $root 'run.mjs'
$url    = "http://127.0.0.1:$Port/"

if (-not (Test-Path $runner)) {
    Write-Host "[start-portal] ERROR: run.mjs not found at $runner"
    exit 1
}
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Host "[start-portal] ERROR: node not found in PATH. Install Node.js first."
    exit 1
}

# --- 1) stop OLD instance(s) on this port (only node processes are killed) ---
$conns = @()
try {
    $conns = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)
} catch { $conns = @() }
if (-not $conns) {
    # fallback for older systems without Get-NetTCPConnection
    $pids = netstat -ano | Select-String ":$Port\s" | Select-String 'LISTENING' |
        ForEach-Object { ($_ -split '\s+')[-1] } | Select-Object -Unique
    $conns = @($pids | ForEach-Object { [pscustomobject]@{ OwningProcess = [int]$_ } })
}

$stopped = 0
foreach ($c in $conns) {
    $opid = $c.OwningProcess
    if (-not $opid -or $opid -eq $PID) { continue }
    try {
        $proc = Get-Process -Id $opid -ErrorAction SilentlyContinue
        if (-not $proc) { continue }
        if ($proc.ProcessName -match '^(node|npm|cmd|powershell|pwsh)$') {
            Stop-Process -Id $opid -Force -ErrorAction SilentlyContinue
            $stopped++
            Write-Host ("[start-portal] Stopped old portal instance (PID {0}, {1})." -f $opid, $proc.ProcessName)
        } else {
            Write-Host ("[start-portal] Port {0} held by {1} (PID {2}) - not a portal process, left untouched." -f $Port, $proc.ProcessName, $opid)
        }
    } catch {
        Write-Host "[start-portal] Could not stop PID $opid : $_"
    }
}
if ($stopped -gt 0) { Start-Sleep -Milliseconds 800 }   # let the port settle before rebinding

# --- 2) start NEW instance (detached, minimized window) ---
$proc = Start-Process -FilePath 'node' `
    -ArgumentList @('run.mjs', 'portal', '--port', "$Port") `
    -WorkingDirectory $root -WindowStyle Minimized -PassThru

# --- 3) wait until it responds, then open the browser ---
$ok = $false
for ($i = 0; $i -lt 40; $i++) {
    Start-Sleep -Milliseconds 500
    try {
        $r = Invoke-WebRequest -Uri ($url + 'api/overview.json') -UseBasicParsing -TimeoutSec 2
        if ($r.StatusCode -eq 200) { $ok = $true; break }
    } catch { }
}

if ($ok) {
    Write-Host "[start-portal] Portal is up (PID $($proc.Id)): $url"
    Write-Host "[start-portal] Opening browser..."
    Start-Process $url
} else {
    Write-Host "[start-portal] ERROR: portal did not respond within 20s."
    Write-Host "[start-portal] The server window (minimized) may show the error; this script will now stop it."
    try { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue } catch { }
    exit 1
}
