$ErrorActionPreference = "Stop"

$ProjectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$Port = if ($env:MANUSCOPY_PORT) { [int]$env:MANUSCOPY_PORT } else { 3000 }
$Url = "http://localhost:$Port"

Write-Host "Starting Manuscopy from: $ProjectRoot" -ForegroundColor Cyan
Write-Host "Using port: $Port" -ForegroundColor Cyan

function Get-ListeningPids {
  param([int]$LocalPort)
  try {
    $pids = Get-NetTCPConnection -LocalPort $LocalPort -State Listen -ErrorAction SilentlyContinue |
      Select-Object -ExpandProperty OwningProcess -Unique
    if ($null -eq $pids) { return @() }
    return @($pids)
  } catch {
    return @()
  }
}

function Wait-UntilPortFree {
  param(
    [int]$LocalPort,
    [int]$TimeoutSeconds = 10
  )
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    $active = Get-ListeningPids -LocalPort $LocalPort
    if ($active.Count -eq 0) { return $true }
    Start-Sleep -Milliseconds 300
  }
  return $false
}

function Stop-OldManuscopyProcesses {
  param(
    [string]$Root,
    [int]$LocalPort
  )

  Write-Host "Stopping old Manuscopy dev processes..." -ForegroundColor Yellow

  $escapedRoot = [regex]::Escape($Root)
  $workspaceProcesses = Get-CimInstance Win32_Process |
    Where-Object {
      $_.CommandLine -and
      $_.CommandLine -match $escapedRoot -and
      ($_.CommandLine -match "next\s+dev" -or $_.CommandLine -match "npm(\.cmd)?\s+run\s+dev")
    }

  foreach ($proc in $workspaceProcesses) {
    try {
      Write-Host "Killing old dev process PID=$($proc.ProcessId)"
      Stop-Process -Id $proc.ProcessId -Force -ErrorAction Stop
    } catch {
      Write-Warning ("Failed to kill PID={0}: {1}" -f $proc.ProcessId, $_.Exception.Message)
    }
  }

  try {
    $portProcessIds = Get-ListeningPids -LocalPort $LocalPort
    foreach ($pid in $portProcessIds) {
      if ($pid -and $pid -ne $PID) {
        try {
          $p = Get-Process -Id $pid -ErrorAction Stop
          Write-Host "Killing process on port $LocalPort PID=$pid ($($p.ProcessName))"
          Stop-Process -Id $pid -Force -ErrorAction Stop
        } catch {
          Write-Warning ("Failed to kill port process PID={0}: {1}" -f $pid, $_.Exception.Message)
          try {
            cmd /c "taskkill /PID $pid /T /F" | Out-Null
          } catch {}
        }
      }
    }
  } catch {
    Write-Warning ("Port cleanup failed: {0}" -f $_.Exception.Message)
  }
}

Stop-OldManuscopyProcesses -Root $ProjectRoot -LocalPort $Port

if (-not (Wait-UntilPortFree -LocalPort $Port -TimeoutSeconds 10)) {
  $left = Get-ListeningPids -LocalPort $Port
  Write-Host "Port $Port is still occupied by PID(s): $($left -join ', ')" -ForegroundColor Red
  Write-Host "Please close those process(es), then run this launcher again." -ForegroundColor Red
  exit 1
}

Write-Host "Launching Next.js dev server..." -ForegroundColor Green

$devCommand = "npm run dev -- -p $Port"
Start-Process powershell.exe `
  -WorkingDirectory $ProjectRoot `
  -ArgumentList @(
    "-NoExit",
    "-ExecutionPolicy", "Bypass",
    "-Command", $devCommand
  )

Start-Sleep -Seconds 3
Write-Host "Opening UI: $Url" -ForegroundColor Green
Start-Process $Url

Write-Host "Done. You can close this launcher window." -ForegroundColor Cyan
