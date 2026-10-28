param([string]$OutputDirectory = (Join-Path $PSScriptRoot '..\..\..\acceptance\permission-fix'))
# Isolated ACL fixtures only; no application, screen or input operation.
$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath($OutputDirectory)
$fixture = Join-Path $root 'automatic app with spaces'
$helper = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..\native\hook-helper\build\context-helper.exe'))
New-Item -ItemType Directory -Path (Join-Path $fixture 'resources') -Force | Out-Null
Copy-Item -LiteralPath $helper -Destination (Join-Path $fixture 'resources\context-helper.exe') -Force
foreach ($name in @('lolPing.exe', 'icudtl.dat', 'resources\app.asar')) {
  Set-Content -LiteralPath (Join-Path $fixture $name) -Value 'synthetic permission fixture'
}
$checks = New-Object 'System.Collections.Generic.List[string]'
function Check([string]$Name, [bool]$Condition) {
  if (-not $Condition) { throw ('FAILED: ' + $Name) }
  $checks.Add($Name)
}
function SidRules([string]$Path, [string]$Sid) {
  @((Get-Acl -LiteralPath $Path).GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]) | Where-Object {
    $_.IdentityReference.Value -eq $Sid
  })
}
$current = [Security.Principal.WindowsIdentity]::GetCurrent().User
$package = New-Object Security.Principal.SecurityIdentifier('S-1-15-2-12345-23456-34567-45678-56789-67890-78901')
$acl = Get-Acl -LiteralPath $fixture
$acl.SetAccessRuleProtection($true, $false)
foreach ($rule in @($acl.GetAccessRules($true, $false, [Security.Principal.SecurityIdentifier]))) { $acl.RemoveAccessRuleSpecific($rule) }
$inherit = [Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'
foreach ($sid in @($current, (New-Object Security.Principal.SecurityIdentifier('S-1-5-18')), $package)) {
  $rights = if ($sid -eq $package) { 'ReadAndExecute' } else { 'FullControl' }
  $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($sid, $rights, $inherit, 'None', 'Allow')))
}
Set-Acl -LiteralPath $fixture -AclObject $acl
$baseAcl = Get-Acl -LiteralPath $fixture
Check 'fixture has package SID and lacks ALL APPLICATION PACKAGES' `
  ((@(SidRules $fixture $package.Value).Count -gt 0) -and (@(SidRules $fixture 'S-1-15-2-1').Count -eq 0))
$result = (& (Join-Path $fixture 'resources\context-helper.exe') --ensure-install-access | Out-String) | ConvertFrom-Json
Check 'automatic native preflight repairs the installation' ($LASTEXITCODE -eq 0 -and $result.status -eq 'repaired')
Check 'original directory DACL is recorded' ([bool]$result.beforeDacl)
$rx = [Security.AccessControl.FileSystemRights]::ReadAndExecute
foreach ($name in @('.', 'icudtl.dat', 'resources\app.asar')) {
  $rules = @(SidRules (Join-Path $fixture $name) 'S-1-15-2-1')
  Check ('read execute inherited: ' + $name) ($rules.Count -gt 0 -and ($rules[0].FileSystemRights -band $rx) -eq $rx)
  Check ('no write permission added: ' + $name) (($rules[0].FileSystemRights -band [Security.AccessControl.FileSystemRights]::Write) -eq 0)
}
Check 'existing package permission preserved' (@(SidRules $fixture $package.Value).Count -gt 0)
Check 'owner full control preserved' ((@(SidRules $fixture $current.Value)[0].FileSystemRights -band
  [Security.AccessControl.FileSystemRights]::FullControl) -eq [Security.AccessControl.FileSystemRights]::FullControl)
$count = @(SidRules $fixture 'S-1-15-2-1').Count
$repeat = (& (Join-Path $fixture 'resources\context-helper.exe') --ensure-install-access | Out-String) | ConvertFrom-Json
Check 'repeat startup leaves ACL unchanged' ($repeat.status -eq 'unchanged' -and @(SidRules $fixture 'S-1-15-2-1').Count -eq $count)
$invalid = (& $helper --ensure-install-access | Out-String) | ConvertFrom-Json
Check 'helper outside a packaged installation rejects repair' ($invalid.status -eq 'failed')
$outside = Join-Path $root 'outside'
New-Item -ItemType Directory -Path $outside -Force | Out-Null
$outsideAcl = (Get-Acl -LiteralPath $outside).Sddl
$linkedFixture = Join-Path $root 'linked app'
New-Item -ItemType Directory -Path (Join-Path $linkedFixture 'resources') -Force | Out-Null
Copy-Item -LiteralPath $helper -Destination (Join-Path $linkedFixture 'resources\context-helper.exe') -Force
foreach ($name in @('lolPing.exe', 'icudtl.dat', 'resources\app.asar')) {
  Set-Content -LiteralPath (Join-Path $linkedFixture $name) -Value 'synthetic permission fixture'
}
Set-Acl -LiteralPath $linkedFixture -AclObject $baseAcl
if (-not (Test-Path -LiteralPath (Join-Path $linkedFixture 'linked'))) {
  New-Item -ItemType Junction -Path (Join-Path $linkedFixture 'linked') -Target $outside | Out-Null
}
$before = (Get-Acl -LiteralPath $linkedFixture).Sddl
$linked = (& (Join-Path $linkedFixture 'resources\context-helper.exe') --ensure-install-access | Out-String) | ConvertFrom-Json
Check 'reparse point rejected without changing any ACL' ($linked.status -eq 'failed' -and $linked.code -eq 4393 -and
  (Get-Acl -LiteralPath $linkedFixture).Sddl -eq $before -and (Get-Acl -LiteralPath $outside).Sddl -eq $outsideAcl)
@{ passed = $checks.Count; checks = @($checks); boundary = 'isolated Windows ACL fixture; not a remote device startup test' } |
  ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $root 'permissions-summary.json') -Encoding UTF8
Get-Content -LiteralPath (Join-Path $root 'permissions-summary.json')
