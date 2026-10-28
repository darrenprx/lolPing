param(
  [switch]$DisableGpu,
  [string]$AppDirectory = $PSScriptRoot,
  [ValidateRange(1, 60)][int]$ObserveSeconds = 12,
  [switch]$NoOpen
)
# Windows PowerShell 5.1; no administrator rights or installed developer tools required.
$ErrorActionPreference = 'Stop'
$diagnosticRoot = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'lolPing\diagnostics'
try { New-Item -ItemType Directory -Path $diagnosticRoot -Force | Out-Null }
catch {
  $diagnosticRoot = Join-Path $env:TEMP 'lolPing\diagnostics'
  New-Item -ItemType Directory -Path $diagnosticRoot -Force | Out-Null
}
$session = Join-Path $diagnosticRoot ((Get-Date -Format 'yyyyMMdd-HHmmss-fff') + '-' + $PID)
New-Item -ItemType Directory -Path $session | Out-Null
$payload = Join-Path $session 'report'
$live = Join-Path $session 'live'
New-Item -ItemType Directory -Path $payload, $live | Out-Null
$report = Join-Path $payload 'launcher.jsonl'
function Record([string]$EventName, [object]$Details) {
  try {
    @{ time = (Get-Date).ToString('o'); event = $EventName; details = $Details } |
      ConvertTo-Json -Compress -Depth 5 | Add-Content -LiteralPath $report -Encoding UTF8
  } catch { }
}
$exe = Join-Path $AppDirectory 'lolPing.exe'
$launchTime = Get-Date
Record 'launcher-start' @{ os = [Environment]::OSVersion.VersionString; os64 = [Environment]::Is64BitOperatingSystem;
  shell64 = [Environment]::Is64BitProcess; powershell = $PSVersionTable.PSVersion.ToString(); disableGpu = [bool]$DisableGpu }
try {
  foreach ($name in @('lolPing.exe', 'resources\app.asar', 'resources\hook-helper.exe', 'resources\context-helper.exe',
    'icudtl.dat', 'resources.pak', 'v8_context_snapshot.bin')) {
    $target = Join-Path $AppDirectory $name
    if (Test-Path -LiteralPath $target -PathType Leaf) {
      $item = Get-Item -LiteralPath $target
      Record 'file' @{ name = $name; bytes = $item.Length; sha256 = (Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash }
    } else { Record 'file-missing' @{ name = $name } }
  }
  foreach ($name in @('.', 'icudtl.dat')) {
    try {
      $acl = Get-Acl -LiteralPath (Join-Path $AppDirectory $name)
      $entries = @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]) | ForEach-Object { @{ sid = $_.IdentityReference.Value;
        rights = $_.FileSystemRights.ToString(); access = $_.AccessControlType.ToString(); inherited = $_.IsInherited } })
      Record 'resource-acl' @{ name = $name; inheritanceProtected = $acl.AreAccessRulesProtected; entries = $entries }
    } catch { Record 'resource-acl-unavailable' @{ name = $name; message = $_.Exception.Message } }
  }
  $existing = @(Get-Process -Name lolPing -ErrorAction SilentlyContinue)
  Record 'existing-processes' @($existing | ForEach-Object { @{ pid = $_.Id; path = try { $_.Path } catch { '' };
    start = try { $_.StartTime.ToString('o') } catch { '' } } })
  $launchArgs = @('--enable-logging', ('--log-file="' + (Join-Path $live 'chromium.log') + '"'))
  if ($DisableGpu) { $launchArgs += '--disable-gpu' }
  $child = Start-Process -FilePath $exe -ArgumentList $launchArgs -WorkingDirectory $AppDirectory -PassThru -WindowStyle Hidden `
    -RedirectStandardOutput (Join-Path $live 'stdout.log') -RedirectStandardError (Join-Path $live 'stderr.log')
  # PowerShell 5.1 can lose ExitCode unless the native process handle is acquired before waiting.
  $childHandle = $child.Handle
  Record 'process-started' @{ pid = $child.Id }
  $exited = $child.WaitForExit($ObserveSeconds * 1000)
  if ($exited) {
    $child.Refresh()
    Record 'process-exited' @{ pid = $child.Id; code = $child.ExitCode }
  } else {
    $child.Refresh()
    Record 'process-running' @{ pid = $child.Id; responding = $child.Responding; windowHandle = $child.MainWindowHandle.ToInt64() }
  }
} catch { Record 'launcher-error' @{ type = $_.Exception.GetType().FullName; message = $_.Exception.Message; hresult = $_.Exception.HResult } }
try {
  $events = Get-WinEvent -FilterHashtable @{ LogName = 'Application'; StartTime = $launchTime.AddMinutes(-5);
    Id = @(1000, 1001, 1002, 33, 59) } -MaxEvents 150 -ErrorAction Stop |
    Where-Object { $_.Message -match '(?i)lolping\.exe|hook-helper\.exe|context-helper\.exe' } |
    Select-Object -First 12 TimeCreated, Id, ProviderName, Message
  @($events) | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $payload 'windows-events.json') -Encoding UTF8
} catch { Record 'windows-events-unavailable' @{ message = $_.Exception.Message } }
try {
  $roots = @((Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'lolPing\logs'), (Join-Path $env:TEMP 'lolPing\logs')) | Select-Object -Unique
  $logTarget = Join-Path $payload 'startup-logs'
  New-Item -ItemType Directory -Path $logTarget | Out-Null
  foreach ($root in $roots) {
    if (Test-Path -LiteralPath $root) {
      Get-ChildItem -LiteralPath $root -Filter 'startup-*.jsonl*' -File |
        Where-Object { -not ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) } |
        Sort-Object LastWriteTime -Descending | Select-Object -First 6 |
        Copy-Item -Destination $logTarget -Force
    }
  }
} catch { Record 'copy-logs-error' @{ message = $_.Exception.Message } }
foreach ($name in @('stdout.log', 'stderr.log', 'chromium.log')) {
  $inputStream = $null
  $outputStream = $null
  try {
    $source = Join-Path $live $name
    if (Test-Path -LiteralPath $source -PathType Leaf) {
      # Chromium keeps its log open. Read a bounded snapshot with sharing, then ZIP the closed copy.
      $inputStream = [IO.File]::Open($source, [IO.FileMode]::Open, [IO.FileAccess]::Read,
        ([IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete))
      $remaining = [Math]::Min($inputStream.Length, 4MB)
      $inputStream.Position = $inputStream.Length - $remaining
      $outputStream = [IO.File]::Create((Join-Path $payload $name))
      $buffer = New-Object byte[] 65536
      while ($remaining -gt 0) {
        $count = $inputStream.Read($buffer, 0, [int][Math]::Min($remaining, $buffer.Length))
        if ($count -eq 0) { break }
        $outputStream.Write($buffer, 0, $count)
        $remaining -= $count
      }
    }
  } catch { Record 'log-snapshot-error' @{ name = $name; message = $_.Exception.Message } }
  finally {
    if ($outputStream) { $outputStream.Dispose() }
    if ($inputStream) { $inputStream.Dispose() }
  }
}
Record 'launcher-complete' @{ session = $session }
try {
  $archive = $session + '.zip'
  Compress-Archive -LiteralPath $payload -DestinationPath $archive -CompressionLevel Optimal
  Write-Output $archive
} catch { Record 'archive-error' @{ message = $_.Exception.Message }; Write-Output $session }
if (-not $NoOpen) { Start-Process -FilePath explorer.exe -ArgumentList ('"' + $diagnosticRoot + '"') }
