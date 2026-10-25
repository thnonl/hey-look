# Reads the screen on a coarse grid over the whole virtual screen (Windows only) and prints one JSON object: the grid points where the window under the point is the
# desktop itself (Progman / WorkerW: no program's window is there) AND the colour is pure white. A hidden window that the compositor still draws (the "ghost" of
# src-tauri/src/ghost.rs: a white rectangle with a shadow, which no window owns for hit testing) shows up as such points. Used by scripts/test-autostart-tray.mjs, which
# takes one read before the app starts and one after and compares them (a white wallpaper or an old ghost is in both and does not count).
#
#   powershell -NoProfile -File scripts/lib/white-desktop.ps1 [-Step 40]
#
# JSON: desktop (points on the bare desktop), white (how many of those are pure white), points ("x,y" of the white ones), locked (the lock screen is up: no read is possible).
param([int]$Step = 40)
$ErrorActionPreference = 'Stop'
if (Get-Process LogonUI -ErrorAction SilentlyContinue) { '{"locked":true,"desktop":0,"white":0,"points":[]}'; exit 0 }
Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using System.Text;
public static class WD {
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
  [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(POINT p);
  [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr h, uint f);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassNameW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern int GetSystemMetrics(int i);
  [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
  public static string Run(int step) {
    SetProcessDPIAware();
    int vx = GetSystemMetrics(76), vy = GetSystemMetrics(77), vw = GetSystemMetrics(78), vh = GetSystemMetrics(79);
    int desktop = 0, white = 0; var pts = new List<string>();
    using (var bmp = new Bitmap(vw, vh, PixelFormat.Format32bppRgb)) {
      using (var g = Graphics.FromImage(bmp)) g.CopyFromScreen(vx, vy, 0, 0, new Size(vw, vh));
      var data = bmp.LockBits(new Rectangle(0, 0, vw, vh), ImageLockMode.ReadOnly, PixelFormat.Format32bppRgb);
      var buf = new byte[data.Stride * vh]; Marshal.Copy(data.Scan0, buf, 0, buf.Length); bmp.UnlockBits(data);
      var cls = new StringBuilder(64);
      for (int y = 0; y < vh; y += step) for (int x = 0; x < vw; x += step) {
        var p = new POINT { X = vx + x, Y = vy + y };
        IntPtr w = WindowFromPoint(p); if (w == IntPtr.Zero) continue;
        IntPtr root = GetAncestor(w, 2); if (root == IntPtr.Zero) root = w;
        cls.Clear(); GetClassNameW(root, cls, 64); string c = cls.ToString();
        if (c != "Progman" && c != "WorkerW") continue;
        desktop++;
        int o = y * data.Stride + x * 4;
        if (buf[o] >= 250 && buf[o + 1] >= 250 && buf[o + 2] >= 250) { white++; pts.Add(p.X + "," + p.Y); }
      }
    }
    return "{\"locked\":false,\"desktop\":" + desktop + ",\"white\":" + white + ",\"points\":[" + (pts.Count > 0 ? "\"" + string.Join("\",\"", pts) + "\"" : "") + "]}";
  }
}
'@
[WD]::Run($Step)
