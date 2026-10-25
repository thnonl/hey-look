# Lists the top-level windows of one Hey Look! process (Windows only) and prints one JSON object. Used by scripts/test-autostart-tray.mjs and by QA by hand.
# QA windows only: it reads the windows of the process id it is given and never touches another program's window.
#
#   powershell -NoProfile -File scripts/lib/tray-start-probe.ps1 -ProcessId 1234
#
# JSON: windows = [{ hwnd, class, title, visible, iconic, exStyle, taskbarButton }], visibleCount (windows of the process that are visible AND not tool windows: the ones a
#       person sees; the single-instance and event-loop helper windows of the process are visible tool windows of no size and are not counted), taskbarButtons (the same count:
#       what the taskbar would show), mainFound / mainVisible (the window titled "Hey Look!").
# A tray start: visibleCount 0, taskbarButtons 0, mainVisible false (mainFound is false while the start gate waits for the desktop and true once the hidden window exists).
param(
  [Parameter(Mandatory = $true)][int]$ProcessId,
  [string]$Title = 'Hey Look!'
)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public static class HLWin {
  delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc p, IntPtr l);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassNameW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll", EntryPoint = "GetWindowLongW")] static extern int GetWindowLong(IntPtr h, int i);
  public static List<Dictionary<string, object>> Of(uint pid) {
    var list = new List<Dictionary<string, object>>();
    EnumWindows((h, l) => {
      uint p; GetWindowThreadProcessId(h, out p);
      if (p != pid) return true;
      var t = new StringBuilder(256); GetWindowTextW(h, t, 256);
      var c = new StringBuilder(256); GetClassNameW(h, c, 256);
      int ex = GetWindowLong(h, -20);
      bool vis = IsWindowVisible(h);
      var o = new Dictionary<string, object>();
      o["hwnd"] = h.ToInt64(); o["class"] = c.ToString(); o["title"] = t.ToString();
      o["visible"] = vis; o["iconic"] = IsIconic(h); o["exStyle"] = "0x" + ex.ToString("x");
      o["taskbarButton"] = vis && (ex & 0x80) == 0; // WS_EX_TOOLWINDOW
      list.Add(o);
      return true;
    }, IntPtr.Zero);
    return list;
  }
}
'@
$ws = [HLWin]::Of([uint32]$ProcessId)
$main = @($ws | Where-Object { $_['title'] -eq $Title -and -not ([string]$_['class']).StartsWith('Tao Thread') })
[ordered]@{
  windows        = @($ws)
  visibleCount   = @($ws | Where-Object { $_['taskbarButton'] }).Count
  taskbarButtons = @($ws | Where-Object { $_['taskbarButton'] }).Count
  mainFound      = $main.Count -gt 0
  mainVisible    = @($main | Where-Object { $_['visible'] }).Count -gt 0
} | ConvertTo-Json -Compress -Depth 4
