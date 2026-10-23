# The install check of the Microsoft Store package on a DISPOSABLE runner (WP14 option A, spec WA.4). Never run it on a PC you keep: it trusts a
# throw-away certificate in the machine's store (Trusted People), installs the package and removes it again.
#   pwsh .github/scripts/msix-check.ps1 -Dir <folder of the artifact msix-test> [-WackReport <file.xml>] [-WaitSeconds 30]
# <folder> holds HeyLook_<V>_x64_test.msix (signed with the throw-away certificate, subject = the Publisher), HeyLook-test.cer (its PUBLIC half) and
# msix-build.json (identity, `ready` = the app has its packaged mode, WP14 part 2). The script
#   1. trusts the certificate and runs Add-AppxPackage on the test-signed package;
#   2. starts the app through its package activation (IApplicationActivationManager, the way the Start menu does) and waits -WaitSeconds;
#   3. checks: the package is installed from WindowsApps, hey-look.exe runs from there and is still alive after the wait (the start-fail dialog of a
#      missing WebView2 would end it), %APPDATA%\thnonl.heylook does not exist;
#      with `ready` = true also: the database heylook.db is in %LOCALAPPDATA%\Packages\<PFN>\LocalState. Without it (until WP14 part 2) the
#      script only LISTS what the app wrote under Packages\<PFN>, the check is a note, not a failure;
#   4. stops the app, Remove-AppxPackage, and checks that %LOCALAPPDATA%\Packages\<PFN> is gone;
#   5. runs the Windows App Certification Kit when appcert.exe exists on the runner (report to -WackReport, FAIL lines in the summary, never a
#      failure of this script: the Store runs its own checks); otherwise the summary says "WACK not available on the runner".
# Writes a table to $env:GITHUB_STEP_SUMMARY. Exit 1 when a required check failed. Nothing is installed besides the package.
param(
  [Parameter(Mandatory = $true)][string]$Dir,
  [string]$WackReport = '',
  [int]$WaitSeconds = 30,
  [string]$SummaryFile = $env:GITHUB_STEP_SUMMARY
)
$ErrorActionPreference = 'Stop'

$rows = New-Object System.Collections.Generic.List[object]
$failed = 0
function Add-Row([string]$Check, [string]$Result, [string]$Detail = '') {
  $rows.Add([pscustomobject]@{ Check = $Check; Result = $Result; Detail = $Detail })
  Write-Host ("{0,-6} {1}  {2}" -f $Result, $Check, $Detail)
  if ($Result -eq 'FAIL') { $script:failed++ }
}
function Write-Summary([string[]]$Extra) {
  if (-not $SummaryFile) { return }
  $lines = @('### MSIX install check', '', '| result | check | detail |', '|---|---|---|')
  foreach ($r in $rows) { $lines += ('| {0} | {1} | {2} |' -f $r.Result, $r.Check, ($r.Detail -replace '\|', '/' -replace "`r?`n", ' ')) }
  $lines += $Extra
  Add-Content -Path $SummaryFile -Value $lines
}

$msix = Get-ChildItem -Path $Dir -Filter 'HeyLook_*_x64_test.msix' | Select-Object -First 1
$cer = Join-Path $Dir 'HeyLook-test.cer'
$info = Get-Content -Raw -Path (Join-Path $Dir 'msix-build.json') | ConvertFrom-Json
if (-not $msix -or -not (Test-Path $cer)) { throw "the folder $Dir has no test-signed package or no HeyLook-test.cer" }
$name = $info.identity.name
$ready = [bool]$info.ready

# a throw-away certificate in a throw-away machine
Import-Certificate -FilePath $cer -CertStoreLocation Cert:\LocalMachine\TrustedPeople | Out-Null
Add-Row 'throw-away certificate trusted (Trusted People)' 'ok'

$pkg = $null
$procs = @()
try {
  Add-AppxPackage -Path $msix.FullName
  $pkg = Get-AppxPackage -Name $name
  if (-not $pkg) { throw "Add-AppxPackage succeeded but Get-AppxPackage -Name $name finds nothing" }
  $pfn = $pkg.PackageFamilyName
  Add-Row 'package installed' 'ok' "$($pkg.PackageFullName), family $pfn"
  if ($pkg.InstallLocation -like '*\WindowsApps\*') { Add-Row 'installed under WindowsApps' 'ok' $pkg.InstallLocation } else { Add-Row 'installed under WindowsApps' 'FAIL' $pkg.InstallLocation }

  $appdata = Join-Path $env:APPDATA 'thnonl.heylook'
  $packages = Join-Path $env:LOCALAPPDATA "Packages\$pfn"

  # IApplicationActivationManager: what the Start menu uses to start a packaged app (explorer's shell:AppsFolder needs a shell session)
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class HeyLookActivation {
  [ComImport, Guid("2e941141-7f97-4756-ba1d-9decde894a3d"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IApplicationActivationManager {
    int ActivateApplication([In, MarshalAs(UnmanagedType.LPWStr)] string appUserModelId, [In, MarshalAs(UnmanagedType.LPWStr)] string arguments, [In] int options, [Out] out uint processId);
    int ActivateForFile([In, MarshalAs(UnmanagedType.LPWStr)] string appUserModelId, [In] IntPtr itemArray, [In, MarshalAs(UnmanagedType.LPWStr)] string verb, [Out] out uint processId);
    int ActivateForProtocol([In, MarshalAs(UnmanagedType.LPWStr)] string appUserModelId, [In] IntPtr itemArray, [Out] out uint processId);
  }
  [ComImport, Guid("45BA127D-10A8-46EA-8AB7-56EA9078943C")] class ApplicationActivationManager { }
  public static uint Start(string aumid) {
    var m = (IApplicationActivationManager)new ApplicationActivationManager();
    uint pid;
    int hr = m.ActivateApplication(aumid, null, 0, out pid);
    if (hr != 0) throw new System.ComponentModel.Win32Exception(hr, "ActivateApplication failed, HRESULT 0x" + hr.ToString("X8"));
    return pid;
  }
}
'@
  $aumid = "$pfn!App"
  $started = [HeyLookActivation]::Start($aumid)
  Add-Row 'started through its package activation' 'ok' "$aumid, process $started"

  # hey-look.exe from the package, up to 30 s to appear
  $deadline = (Get-Date).AddSeconds(30)
  do {
    Start-Sleep -Seconds 1
    $procs = @(Get-CimInstance Win32_Process -Filter "Name = 'hey-look.exe'" | Where-Object { $_.ExecutablePath -like '*\WindowsApps\*' })
  } while ($procs.Count -eq 0 -and (Get-Date) -lt $deadline)
  if ($procs.Count -eq 0) {
    Add-Row 'hey-look.exe runs from WindowsApps' 'FAIL' 'no process of the package after 30 s'
  } else {
    Add-Row 'hey-look.exe runs from WindowsApps' 'ok' $procs[0].ExecutablePath
    Start-Sleep -Seconds $WaitSeconds
    $alive = @($procs | Where-Object { Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue })
    if ($alive.Count -gt 0) { Add-Row "still running after $WaitSeconds s (no start-fail dialog, no crash)" 'ok' ("process " + (($alive | ForEach-Object { $_.ProcessId }) -join ', ')) }
    else { Add-Row "still running after $WaitSeconds s (no start-fail dialog, no crash)" 'FAIL' 'the process ended' }
  }

  if (Test-Path $appdata) { Add-Row '%APPDATA%\thnonl.heylook is absent' 'FAIL' $appdata } else { Add-Row '%APPDATA%\thnonl.heylook is absent' 'ok' }
  $db = Join-Path $packages 'LocalState\heylook.db'
  if (Test-Path $db) { Add-Row 'database in Packages\<PFN>\LocalState' 'ok' $db }
  elseif ($ready) { Add-Row 'database in Packages\<PFN>\LocalState' 'FAIL' "$db does not exist" }
  else { Add-Row 'database in Packages\<PFN>\LocalState' 'note' 'not required yet: the packaged mode of the app comes with WP14 part 2 (readiness.json)' }
  if (Test-Path $packages) {
    $listing = (Get-ChildItem -Path $packages -Recurse -Depth 3 -Force -ErrorAction SilentlyContinue | Select-Object -First 40 | ForEach-Object { $_.FullName.Substring($packages.Length) }) -join '; '
    Add-Row 'what the app wrote under Packages\<PFN>' 'note' $listing
  }
} catch {
  Add-Row 'the check itself' 'FAIL' $_.Exception.Message
} finally {
  # stop only the processes of the package, then remove it
  foreach ($p in @(Get-CimInstance Win32_Process -Filter "Name = 'hey-look.exe'" | Where-Object { $_.ExecutablePath -like '*\WindowsApps\*' })) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }
  if ($pkg) {
    try {
      Remove-AppxPackage -Package $pkg.PackageFullName
      $gone = $false
      $until = (Get-Date).AddSeconds(30)
      while (-not $gone -and (Get-Date) -lt $until) { if (-not (Test-Path (Join-Path $env:LOCALAPPDATA "Packages\$($pkg.PackageFamilyName)"))) { $gone = $true } else { Start-Sleep -Seconds 1 } }
      if ($gone) { Add-Row 'removed: Packages\<PFN> is gone' 'ok' } else { Add-Row 'removed: Packages\<PFN> is gone' 'FAIL' 'the folder is still there 30 s after Remove-AppxPackage' }
    } catch {
      Add-Row 'removed: Packages\<PFN> is gone' 'FAIL' $_.Exception.Message
    }
  }
}

# the Windows App Certification Kit, when the runner has it: informational
$extra = @('')
$appcert = @('C:\Program Files (x86)\Windows Kits\10\App Certification Kit\appcert.exe', 'C:\Program Files\Windows Kits\10\App Certification Kit\appcert.exe') | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $appcert) {
  $extra += 'WACK not available on the runner (appcert.exe not found): no certification kit report.'
} else {
  $report = if ($WackReport) { $WackReport } else { Join-Path $Dir 'wack-report.xml' }
  try {
    & $appcert reset | Out-Null
    & $appcert test -appxpackagepath $msix.FullName -reportoutputpath $report | Out-Host
    if (Test-Path $report) {
      [xml]$x = Get-Content -Raw -Path $report
      $fails = @($x.SelectNodes('//TEST[@RESULT="FAIL"]'))
      $extra += "WACK report $report : $($fails.Count) FAIL test(s)."
      foreach ($f in $fails) { $extra += ('- {0}: {1}' -f $f.NAME, ($f.DESCRIPTION -replace "`r?`n", ' ')) }
    } else {
      $extra += 'WACK ran but wrote no report.'
    }
  } catch {
    $extra += "WACK could not be run: $($_.Exception.Message)"
  }
}
Write-Summary $extra
if ($failed -gt 0) { Write-Host "::error::$failed required check(s) failed"; exit 1 }
Write-Host 'msix-check: all required checks passed'
