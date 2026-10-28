param([Parameter(Mandatory = $true)][string]$AppDirectory,
  [string]$OutputDirectory = (Join-Path $PSScriptRoot '..\..\..\acceptance\permission-fix'))
# Acceptance-only: add a synthetic package read ACE, exercise the real packaged startup, then remove that ACE.
$ErrorActionPreference = 'Stop'
$appRoot = [IO.Path]::GetFullPath($AppDirectory).TrimEnd('\')
if ($appRoot -eq [IO.Path]::GetPathRoot($appRoot).TrimEnd('\')) { throw 'Installation cannot be a volume root' }
foreach ($name in @('lolPing.exe', 'icudtl.dat', 'resources\app.asar', 'resources\context-helper.exe')) {
  if (-not (Test-Path -LiteralPath (Join-Path $appRoot $name) -PathType Leaf)) { throw ('Missing resource: ' + $name) }
}
$pending = New-Object 'System.Collections.Generic.Stack[string]'
$pending.Push($appRoot)
while ($pending.Count) {
  $directory = $pending.Pop()
  if ((Get-Item -LiteralPath $directory -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Reparse point' }
  foreach ($entry in Get-ChildItem -LiteralPath $directory -Force) {
    if ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Reparse point' }
    if ($entry.PSIsContainer) { $pending.Push($entry.FullName) }
  }
}
if (@(Get-Process lolPing -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq (Join-Path $appRoot 'lolPing.exe') }).Count) {
  throw 'The installation must be stopped before this acceptance test'
}
$sid = New-Object Security.Principal.SecurityIdentifier('S-1-15-2-12345-23456-34567-45678-56789-67890-78901')
$before = Get-Acl -LiteralPath $appRoot
$rules = @($before.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))
if (@($rules | Where-Object { $_.IdentityReference -eq $sid -or $_.IdentityReference.Value -eq 'S-1-15-2-1' }).Count) {
  throw 'Synthetic test requires an unmodified baseline without package ACEs'
}
New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null
@{ directory = $appRoot; sddl = $before.Sddl } | ConvertTo-Json |
  Set-Content -LiteralPath (Join-Path $OutputDirectory 'installed-acl-before.json') -Encoding UTF8
$before.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule(
  $sid, 'ReadAndExecute', 'ContainerInherit, ObjectInherit', 'None', 'Allow')))
$process = $null
$passed = $false
try {
  Set-Acl -LiteralPath $appRoot -AclObject $before
  $process = Start-Process -FilePath (Join-Path $appRoot 'lolPing.exe') -PassThru
  $logRoot = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'lolPing\logs'
  $watch = [Diagnostics.Stopwatch]::StartNew()
  while ($watch.Elapsed.TotalSeconds -lt 20) {
    $log = Get-ChildItem -LiteralPath $logRoot -Filter ('startup-*-' + $process.Id + '.jsonl') -ErrorAction SilentlyContinue |
      Select-Object -First 1
    $events = if ($log) { @(Get-Content -LiteralPath $log.FullName | ForEach-Object { $_ | ConvertFrom-Json }) } else { @() }
    $settings = @($events | Where-Object { $_.event -eq 'page-request' -and $_.page -eq 'settings' })
    $shown = @($events | Where-Object { $_.event -eq 'window-shown' -and $settings.window -contains $_.id })
    $running = @($events | Where-Object { $_.event -eq 'input-helper-status' -and $_.status -eq 'running' })
    if ($shown.Count -gt 0 -and $running.Count -gt 0) { break }
    if (@($events | Where-Object { $_.event -in @('bootstrap-failed','startup-failed') }).Count) { throw 'Packaged startup failed' }
    Start-Sleep -Milliseconds 100
  }
  if (@($events | Where-Object { $_.event -eq 'install-access' -and $_.status -eq 'repaired' }).Count -ne 1 -or
      $shown.Count -eq 0 -or $running.Count -eq 0) { throw 'Packaged repair or window startup did not complete' }
  Copy-Item -LiteralPath $log.FullName -Destination (Join-Path $OutputDirectory 'installed-startup.jsonl') -Force
  $result = [ordered]@{ automaticRepair = $true; settingsWindowShown = $true; helperRunning = $true;
    build = @($events | Where-Object event -eq 'local-build')[0].build; mainPid = $process.Id;
    boundary = 'real local packaged app and synthetic install ACL; remote device still needs confirmation' }
  $passed = $true
} finally {
  $after = Get-Acl -LiteralPath $appRoot
  $after.PurgeAccessRules($sid)
  Set-Acl -LiteralPath $appRoot -AclObject $after
  if (-not $passed -and $process -and -not $process.HasExited) { Stop-Process -Id $process.Id }
}
$repeat = Start-Process -FilePath (Join-Path $appRoot 'lolPing.exe') -ArgumentList '--hidden' -PassThru
$handle = $repeat.Handle
if (-not $repeat.WaitForExit(10000) -or $repeat.ExitCode -ne 0) { throw 'Repeated launch did not exit normally' }
$repeatLog = Get-ChildItem -LiteralPath $logRoot -Filter ('startup-*-' + $repeat.Id + '.jsonl') | Select-Object -First 1
$repeatEvents = @(Get-Content -LiteralPath $repeatLog.FullName | ForEach-Object { $_ | ConvertFrom-Json })
if (@($repeatEvents | Where-Object { $_.event -eq 'install-access' -and $_.status -eq 'unchanged' }).Count -ne 1) {
  throw 'Healthy repeated launch changed the ACL'
}
$result.repeatStartupUnchanged = $true
$result.syntheticPackageAceRemoved = @((Get-Acl -LiteralPath $appRoot).GetAccessRules($true,$true,
  [Security.Principal.SecurityIdentifier]) | Where-Object { $_.IdentityReference -eq $sid }).Count -eq 0
$result | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $OutputDirectory 'installed-startup-summary.json') -Encoding UTF8
$result | ConvertTo-Json
