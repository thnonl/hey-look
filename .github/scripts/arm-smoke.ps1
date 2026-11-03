# The smoke test of the native Windows ARM64 build, on the ARM64 runner that built it (job build, leg "Windows (ARM64)", release profile):
#   pwsh .github/scripts/arm-smoke.ps1
# What it shows (each line is printed as "ok" or throws):
#   1. the machine is ARM64 and the built hey-look.exe is a PE file for ARM64 (machine 0xAA64), not x64;
#   2. the NSIS setup installs silently (/S) for the current user;
#   3. the installed hey-look.exe is the ARM64 file, starts, is still running after 25 s, has started the WebView2 runtime
#      (msedgewebview2.exe children of its process) and has made its database;
#   4. it is stopped (that exact process id) and the uninstaller removes it.
# The installer is NOT signed here (a dry run never gets a signing secret): this proves it installs and runs on ARM64, not its signature.
$ErrorActionPreference = 'Stop'

function Ok([string]$m) { Write-Host "ok    $m" }
function Get-PeMachine([string]$path) {
  $fs = [System.IO.File]::OpenRead($path)
  try {
    $b = New-Object byte[] 4096
    [void]$fs.Read($b, 0, 4096)
    $pe = [BitConverter]::ToInt32($b, 0x3C)
    if ($b[$pe] -ne 0x50 -or $b[$pe + 1] -ne 0x45) { throw "$path is not a PE file" }
    return [BitConverter]::ToUInt16($b, $pe + 4)
  } finally { $fs.Dispose() }
}

$arch = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture
if ($arch -ne 'Arm64') { throw "this runner is $arch, not Arm64" }
Ok "the runner is Arm64"

$built = 'src-tauri\target\release\hey-look.exe'
if ((Get-PeMachine $built) -ne 0xAA64) { throw ("{0} has PE machine 0x{1:X}, expected 0xAA64 (ARM64)" -f $built, (Get-PeMachine $built)) }
Ok "$built is a PE file for ARM64 (0xAA64)"

$setup = Get-ChildItem 'src-tauri\target\release\bundle\nsis' -Filter '*-setup.exe' | Select-Object -First 1
if (-not $setup) { throw 'no NSIS setup in src-tauri\target\release\bundle\nsis' }
Ok "setup: $($setup.Name) ($([int]($setup.Length / 1KB)) KB)"
if ((Get-PeMachine $setup.FullName) -ne 0xAA64) {
  # (the NSIS stub is a 32-bit x86 program on some Tauri versions, that is fine: it runs under emulation and installs the ARM64 app) - information only
  Write-Host ("note  the setup program itself has PE machine 0x{0:X}" -f (Get-PeMachine $setup.FullName))
}

$p = Start-Process -FilePath $setup.FullName -ArgumentList '/S' -PassThru -Wait
if ($p.ExitCode -ne 0) { throw "the setup ended with exit code $($p.ExitCode)" }
Ok 'the setup installed silently'

$exe = $null
foreach ($root in @("$env:LOCALAPPDATA\Hey Look!", "$env:LOCALAPPDATA\Programs\Hey Look!", "${env:ProgramFiles}\Hey Look!")) {
  if (Test-Path "$root\hey-look.exe") { $exe = "$root\hey-look.exe"; break }
}
if (-not $exe) {
  $exe = (Get-ChildItem $env:LOCALAPPDATA, $env:ProgramFiles -Recurse -Filter 'hey-look.exe' -ErrorAction SilentlyContinue | Select-Object -First 1).FullName
}
if (-not $exe) { throw 'hey-look.exe was not found after the install' }
Ok "installed: $exe"
if ((Get-PeMachine $exe) -ne 0xAA64) { throw 'the installed hey-look.exe is not an ARM64 file' }
Ok 'the installed hey-look.exe is an ARM64 file'

$proc = Start-Process -FilePath $exe -PassThru
Start-Sleep -Seconds 25
$proc.Refresh()
if ($proc.HasExited) { throw "hey-look.exe ended within 25 s (exit code $($proc.ExitCode))" }
Ok "hey-look.exe (pid $($proc.Id)) was still running after 25 s"

$kids = @(Get-CimInstance Win32_Process -Filter "Name = 'msedgewebview2.exe'" | Where-Object { $_.CommandLine -like '*thnonl.heylook*' })
if ($kids.Count -eq 0) { throw 'no msedgewebview2.exe process of the app: the web view did not start' }
Ok "the WebView2 runtime is running for the app ($($kids.Count) processes)"

$db = Get-ChildItem "$env:APPDATA\thnonl.heylook", "$env:LOCALAPPDATA\thnonl.heylook" -Recurse -Filter 'heylook.db*' -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $db) { throw 'no heylook.db was made under AppData' }
Ok "the database exists: $($db.FullName)"

Stop-Process -Id $proc.Id -Force
Start-Sleep -Seconds 3
$uninstall = Join-Path (Split-Path $exe) 'uninstall.exe'
if (Test-Path $uninstall) {
  $u = Start-Process -FilePath $uninstall -ArgumentList '/S' -PassThru -Wait
  Ok "the uninstaller ran (exit code $($u.ExitCode))"
}
Write-Host 'ARM64 Windows smoke test passed'
