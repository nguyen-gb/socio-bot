param(
  [switch]$SkipMigrate,
  [switch]$InfrastructureOnly
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location $projectRoot

function Import-DotEnv {
  param([string]$Path)

  if (-not (Test-Path -LiteralPath $Path)) {
    throw "Missing environment file: $Path"
  }

  Get-Content -LiteralPath $Path | ForEach-Object {
    if ($_ -match '^\s*([^#=\s]+)\s*=(.*)$') {
      [Environment]::SetEnvironmentVariable(
        $matches[1],
        $matches[2].Trim(),
        'Process'
      )
    }
  }
}

function Test-TcpPort {
  param(
    [string]$HostName,
    [int]$Port
  )

  $client = [System.Net.Sockets.TcpClient]::new()
  try {
    $connection = $client.ConnectAsync($HostName, $Port)
    return $connection.Wait(1000) -and $client.Connected
  }
  catch {
    return $false
  }
  finally {
    $client.Dispose()
  }
}

function Wait-ForPort {
  param(
    [string]$Name,
    [string]$HostName,
    [int]$Port,
    [int]$TimeoutSeconds = 30
  )

  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    if (Test-TcpPort -HostName $HostName -Port $Port) {
      return
    }
    Start-Sleep -Milliseconds 500
  }

  throw "$Name did not start on ${HostName}:$Port within $TimeoutSeconds seconds."
}

function Test-PostgresReady {
  & $postgresReady -q -h 127.0.0.1 -p 55432 -U $postgresUser -d $postgresDatabase -t 2
  return $LASTEXITCODE -eq 0
}

function Wait-ForPostgres {
  $deadline = (Get-Date).AddSeconds(45)
  while ((Get-Date) -lt $deadline) {
    if (Test-PostgresReady) { return }
    Start-Sleep -Milliseconds 500
  }
  throw "PostgreSQL is not accepting connections on localhost:55432. Check $logRoot\postgres.log. An open port alone does not mean the database is ready."
}

Import-DotEnv -Path (Join-Path $projectRoot '.env')

$postgresUri = [Uri]$env:DATABASE_URL
$postgresUser = [Uri]::UnescapeDataString(($postgresUri.UserInfo -split ':', 2)[0])
$postgresDatabase = [Uri]::UnescapeDataString($postgresUri.AbsolutePath.TrimStart('/'))
if (-not $postgresUser -or -not $postgresDatabase) {
  throw 'DATABASE_URL must specify the PostgreSQL user and database.'
}

$localRoot = Join-Path $projectRoot '.local'
$logRoot = Join-Path $localRoot 'logs'
$postgresData = Join-Path $localRoot 'postgres'
$postgresCtl = 'C:\Program Files\PostgreSQL\17\bin\pg_ctl.exe'
$postgresReady = 'C:\Program Files\PostgreSQL\17\bin\pg_isready.exe'
$temporalExe = Join-Path $localRoot 'temporal\temporal.exe'

New-Item -ItemType Directory -Force -Path $logRoot | Out-Null

if (-not (Test-Path -LiteralPath $postgresReady)) {
  throw "PostgreSQL readiness tool is missing: $postgresReady"
}

if (-not (Test-PostgresReady)) {
  if (-not (Test-Path -LiteralPath (Join-Path $postgresData 'PG_VERSION'))) {
    throw 'Local PostgreSQL is not initialized. Run the project setup first.'
  }
  if (-not (Test-TcpPort -HostName '127.0.0.1' -Port 55432)) {
    # Give pg_ctl a separate hidden console. Direct invocation lets Ctrl+C in
    # the application terminal reach PostgreSQL's inherited console too.
    $postgresLauncher = Start-Process `
      -FilePath $postgresCtl `
      -ArgumentList @(
        '-D', ('"{0}"' -f $postgresData),
        '-l', ('"{0}"' -f (Join-Path $logRoot 'postgres.log')),
        '-o', '"-p 55432 -h 127.0.0.1"',
        '-w', '-t', '30', 'start'
      ) `
      -WorkingDirectory $projectRoot `
      -WindowStyle Hidden `
      -PassThru
    # Start-Process -Wait waits for descendants, including the database daemon.
    # Wait only for the short-lived pg_ctl launcher instead.
    if (-not $postgresLauncher.WaitForExit(45000)) {
      throw "PostgreSQL launcher timed out. Check $logRoot\postgres.log."
    }
    if ($postgresLauncher.ExitCode -ne 0) {
      throw "PostgreSQL failed to start with exit code $($postgresLauncher.ExitCode). Check $logRoot\postgres.log."
    }
  }
  Wait-ForPostgres
}

if (-not (Test-TcpPort -HostName '127.0.0.1' -Port 6379)) {
  throw 'Redis is not running on localhost:6379. Start the installed Redis service and retry.'
}

if (-not (Test-TcpPort -HostName '127.0.0.1' -Port 7233)) {
  if (-not (Test-Path -LiteralPath $temporalExe)) {
    throw 'Temporal CLI is missing. Run the project setup first.'
  }

  $temporalProcess = Start-Process `
    -FilePath $temporalExe `
    -ArgumentList @(
      'server', 'start-dev',
      '--ip', '127.0.0.1',
      '--port', '7233',
      '--ui-port', '8233',
      '--db-filename', (Join-Path $localRoot 'temporal\temporal.db')
    ) `
    -WorkingDirectory $projectRoot `
    -WindowStyle Hidden `
    -RedirectStandardOutput (Join-Path $logRoot 'temporal.out.log') `
    -RedirectStandardError (Join-Path $logRoot 'temporal.err.log') `
    -PassThru
  Set-Content -LiteralPath (Join-Path $localRoot 'temporal.pid') -Value $temporalProcess.Id
  Wait-ForPort -Name 'Temporal' -HostName '127.0.0.1' -Port 7233
}

if ($InfrastructureOnly) {
  Write-Host 'Local infrastructure is ready: PostgreSQL 55432, Redis 6379, Temporal 7233.'
  Write-Host 'Infrastructure stays running when this terminal exits or receives Ctrl+C.'
  return
}

$runningAppPorts = @(3000, 3001, 3010 | Where-Object {
  Test-TcpPort -HostName '127.0.0.1' -Port $_
})
if ($runningAppPorts.Count -eq 3) {
  try {
    $apiReady = Invoke-RestMethod -Uri 'http://127.0.0.1:3001/api/health/ready' -TimeoutSec 10
    if ($apiReady.status -ne 'ready') { throw 'API is not ready' }
  } catch {
    throw 'Application ports are open but API readiness failed. Check /api/health/ready and the API logs before using the dashboard.'
  }
  Write-Host 'Socio is already running.'
  Write-Host 'Dashboard:   http://localhost:3000'
  Write-Host 'API ready:   http://localhost:3001/api/health/ready'
  Write-Host 'Temporal UI: http://localhost:8233'
  exit 0
}
if ($runningAppPorts.Count -gt 0) {
  throw "Only some application ports are occupied: $($runningAppPorts -join ', '). Stop those processes and retry."
}

if (-not $SkipMigrate) {
  corepack pnpm --filter '@socio/database' prisma:deploy
  if ($LASTEXITCODE -ne 0) {
    throw "Database migration failed with exit code $LASTEXITCODE."
  }
}

Write-Host 'Socio local infrastructure is ready.'
Write-Host 'Dashboard:   http://localhost:3000'
Write-Host 'API ready:   http://localhost:3001/api/health/ready'
Write-Host 'Temporal UI: http://localhost:8233'
Write-Host 'Press Ctrl+C to stop application processes only; local infrastructure stays running.'

corepack pnpm dev
exit $LASTEXITCODE
