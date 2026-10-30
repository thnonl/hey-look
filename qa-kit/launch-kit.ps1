# Hey Look! 1.0.11 RC1 QA launcher (Windows host). Starts the newest QA exe in this folder with its OWN data folder and WebView2 CDP on a free port.
# Never touches %APPDATA%\thnonl.heylook or the installed app. Stops nothing.
# The window is moved to the SECOND monitor (owner rule: never the primary): -Monitor 2 (default) places it at X=3200,Y=0, 2400x1350 (\\.\DISPLAY1); -Monitor 0 leaves it where the app puts it
# (do not use that on the owner's host). The move is made as soon as the window exists (it starts hidden); the launcher waits up to 40 s for it.
# -SmtpFail refuse|auth|temp: every send fails like a server answer (550 / 535 / 451), for the send-failure rows (env HEYLOOK_QA_SMTP_FAIL, qa-secrets kit only)
# usage: powershell -NoProfile -ExecutionPolicy Bypass -File launch-kit.ps1 [-Port 0] [-DataDir <dir>] [-Monitor 2] [-X 3200 -Y 0 -W 2400 -H 1350] [-SmtpFail refuse]
# prints one JSON line: {pid, cdpPort, cdpUrl, dataDir, bridgeFile, window}
param([int]$Port = 0, [string]$DataDir = 'E:\hey-mail\test-builds\v1011-rc1\data', [int]$Monitor = 2, [int]$X = 3200, [int]$Y = 0, [int]$W = 2400, [int]$H = 1350, [string]$SmtpFail = '')
$ErrorActionPreference = 'Stop'
$kit = Split-Path -Parent $MyInvocation.MyCommand.Path
$exe = Get-ChildItem -LiteralPath $kit -Filter 'hey-look-qa-1011-rc1-*.exe' | Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not $exe) { throw 'kit exe missing' }
if ($DataDir -match 'thnonl\.heylook($|[\\/])' -and $DataDir -notmatch 'qa') { throw 'refusing the real data folder' }
if ($Port -eq 0) {
  $l = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0); $l.Start(); $Port = $l.LocalEndpoint.Port; $l.Stop()
}
New-Item -ItemType Directory -Force -Path $DataDir | Out-Null
$env:HEYLOOK_DATA_DIR = $DataDir
$env:HEYLOOK_TEST_BRIDGE = '0'
if ($SmtpFail) { $env:HEYLOOK_QA_SMTP_FAIL = $SmtpFail } else { $env:HEYLOOK_QA_SMTP_FAIL = $null }
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=$Port --remote-allow-origins=*"
# own roaming/local folders under the data folder (own WebView2 profile too)
$env:APPDATA = Join-Path $DataDir 'appdata'; $env:LOCALAPPDATA = Join-Path $DataDir 'localappdata'
New-Item -ItemType Directory -Force -Path $env:APPDATA, $env:LOCALAPPDATA | Out-Null
$p = Start-Process -FilePath $exe.FullName -PassThru
$placed = 'not moved'
if ($Monitor -ne 0) {
  Add-Type -TypeDefinition @"
using System; using System.Runtime.InteropServices; using System.Text; using System.Collections.Generic;
public static class KitWin {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc p, IntPtr l);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int w, int hgt, uint flags);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  public static List<IntPtr> Visible(uint pid) {
    var r = new List<IntPtr>();
    EnumWindows((h, l) => { uint p; GetWindowThreadProcessId(h, out p); if (p == pid && IsWindowVisible(h)) { var sb = new StringBuilder(256); GetWindowText(h, sb, 256); if (sb.Length > 0) r.Add(h); } return true; }, IntPtr.Zero);
    return r;
  }
}
"@
  $end = (Get-Date).AddSeconds(40)
  while ((Get-Date) -lt $end) {
    # the exe may hand over to a second process of itself: look at every process that runs this exe
    $mine = @(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $exe.FullName })
    if ($mine.Count -gt 0) { $p = $mine[0] }
    $ws = @(); foreach ($q in $mine) { $ws += [KitWin]::Visible([uint32]$q.Id) }
    if ($ws.Count -gt 0) {
      foreach ($hw in $ws) { [void][KitWin]::ShowWindow($hw, 9); [void][KitWin]::SetWindowPos($hw, [IntPtr]::Zero, $X, $Y, $W, $H, 0x0044) }  # SWP_NOZORDER | SWP_NOACTIVATE, after SW_RESTORE
      $placed = "moved $($ws.Count) window(s) to X=$X Y=$Y ${W}x${H}"
      # the app places its own window again while it starts (about 1-3 s): hold the position for 12 s more
      $hold = (Get-Date).AddSeconds(12)
      while ((Get-Date) -lt $hold) {
        Start-Sleep -Milliseconds 250
        foreach ($q in @(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $exe.FullName })) { foreach ($hw in [KitWin]::Visible([uint32]$q.Id)) { [void][KitWin]::SetWindowPos($hw, [IntPtr]::Zero, $X, $Y, $W, $H, 0x0044) } }
      }
      break
    }
    Start-Sleep -Milliseconds 100
  }
}
[ordered]@{ pid = $p.Id; cdpPort = $Port; cdpUrl = "http://127.0.0.1:$Port/json"; dataDir = $DataDir; bridgeFile = (Join-Path $DataDir 'test-bridge.json'); window = $placed } | ConvertTo-Json -Compress
