# Reads the pixels of the client area of a Hey Look! window (Windows only) and prints one JSON object: how much of it is one colour.
# Used by scripts/test-blank-after-show.mjs (D-057) and by QA by hand. QA windows only: it never touches another program's window.
#
#   powershell -NoProfile -File scripts/lib/window-pixels.ps1 -ProcessId 1234 [-Mode screen|print] [-Raise] [-Save out.png] [-Title "Hey Look!"]
#
# -Mode screen (default): copies the client area from the screen (what the desktop compositor shows, so a web view that is not painted
#   reads as the colour under it); points that another window covers are left out (WindowFromPoint), so an overlapping window cannot fake
#   a painted or a blank result. This is the same read the app itself does (startup.rs, `screen_probe`).
# -Mode print: PrintWindow(PW_RENDERFULLCONTENT), which asks the web view's browser process to render (it does not show what is on screen).
# -Raise: bring the window to the front first (the QA window of this process; also put above the other windows without activating it).
#
# JSON: found, visible, iconic, cloaked, clientW, clientH, samples, owned, dominantRgb, dominantRatio, distinct, whiteRatio, meanRgb, ms
param(
  [Parameter(Mandatory = $true)][int]$ProcessId,
  [ValidateSet('screen', 'print')][string]$Mode = 'screen',
  [switch]$Raise,
  [string]$Save = '',
  [string]$Title = 'Hey Look!'
)
$ErrorActionPreference = 'Stop'
Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using System.Text;
public static class HLPix {
  [StructLayout(LayoutKind.Sequential)] struct RECT { public int L, T, R, B; }
  [StructLayout(LayoutKind.Sequential)] struct POINT { public int X, Y; }
  [StructLayout(LayoutKind.Sequential)] struct BMIH { public int Size, W, H; public short Planes, Bits; public int Comp, ImgSize, XPpm, YPpm, ClrUsed, ClrImp; }
  delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc p, IntPtr l);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassNameW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] static extern bool GetClientRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] static extern bool ClientToScreen(IntPtr h, ref POINT p);
  [DllImport("user32.dll")] static extern IntPtr GetDC(IntPtr h);
  [DllImport("user32.dll")] static extern int ReleaseDC(IntPtr h, IntPtr dc);
  [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(POINT p);
  [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr h, uint flags);
  [DllImport("user32.dll")] static extern bool PrintWindow(IntPtr h, IntPtr dc, uint flags);
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
  [DllImport("gdi32.dll")] static extern IntPtr CreateCompatibleDC(IntPtr dc);
  [DllImport("gdi32.dll")] static extern IntPtr CreateCompatibleBitmap(IntPtr dc, int w, int h);
  [DllImport("gdi32.dll")] static extern IntPtr SelectObject(IntPtr dc, IntPtr o);
  [DllImport("gdi32.dll")] static extern bool DeleteObject(IntPtr o);
  [DllImport("gdi32.dll")] static extern bool DeleteDC(IntPtr dc);
  [DllImport("gdi32.dll")] static extern bool BitBlt(IntPtr d, int x, int y, int w, int h, IntPtr s, int sx, int sy, uint rop);
  [DllImport("gdi32.dll")] static extern int GetDIBits(IntPtr dc, IntPtr bmp, uint start, uint lines, byte[] bits, ref BMIH bi, uint usage);
  [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int attr, out int v, int size);

  public static IntPtr Find(uint pid, string title) {
    IntPtr found = IntPtr.Zero;
    EnumWindows((h, l) => {
      uint p; GetWindowThreadProcessId(h, out p);
      if (p != pid) return true;
      var t = new StringBuilder(256); GetWindowTextW(h, t, 256);
      var c = new StringBuilder(256); GetClassNameW(h, c, 256);
      if (t.ToString() == title && !c.ToString().StartsWith("Tao Thread")) { found = h; return false; }
      return true;
    }, IntPtr.Zero);
    return found;
  }

  [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int w, int hh, uint f);
  // the foreground right is not always there (a window that another program covers stays covered), so the QA window is also put above the others without being activated
  public static void Raise(IntPtr h) { SetForegroundWindow(h); SetWindowPos(h, (IntPtr)(-1), 0, 0, 0, 0, 0x0001 | 0x0002 | 0x0010); }

  public static Dictionary<string, object> Measure(IntPtr hwnd, bool print, string save) {
    SetProcessDPIAware();
    var sw = System.Diagnostics.Stopwatch.StartNew();
    var o = new Dictionary<string, object>();
    o["visible"] = IsWindowVisible(hwnd); o["iconic"] = IsIconic(hwnd);
    int cloaked; DwmGetWindowAttribute(hwnd, 14, out cloaked, 4); o["cloaked"] = cloaked != 0;
    RECT cr; GetClientRect(hwnd, out cr);
    int w = cr.R - cr.L, h = cr.B - cr.T;
    o["clientW"] = w; o["clientH"] = h;
    if (w < 50 || h < 50) { o["samples"] = 0; o["owned"] = 0; return o; }
    var origin = new POINT { X = 0, Y = 0 }; ClientToScreen(hwnd, ref origin);
    IntPtr screen = GetDC(IntPtr.Zero), mem = CreateCompatibleDC(screen), bmp = CreateCompatibleBitmap(screen, w, h), old = SelectObject(mem, bmp);
    if (print) PrintWindow(hwnd, mem, 2); else BitBlt(mem, 0, 0, w, h, screen, origin.X, origin.Y, 0x00CC0020u | 0x40000000u);
    var bi = new BMIH { Size = 40, W = w, H = -h, Planes = 1, Bits = 32 };
    var buf = new byte[w * h * 4];
    GetDIBits(mem, bmp, 0, (uint)h, buf, ref bi, 0);
    SelectObject(mem, old); DeleteObject(bmp); DeleteDC(mem); ReleaseDC(IntPtr.Zero, screen);
    var count = new Dictionary<int, int>();
    int samples = 0, owned = 0, white = 0; long sr = 0, sg = 0, sb = 0;
    const int cols = 64, rows = 40;
    for (int j = 0; j < rows; j++) for (int i = 0; i < cols; i++) {
      int x = 4 + (w - 8) * i / (cols - 1), y = 4 + (h - 8) * j / (rows - 1);
      samples++;
      if (!print) {
        var pt = new POINT { X = origin.X + x, Y = origin.Y + y };
        IntPtr top = GetAncestor(WindowFromPoint(pt), 2);
        if (top != hwnd) continue;
      }
      owned++;
      int off = (y * w + x) * 4; int b = buf[off], g = buf[off + 1], r = buf[off + 2];
      int key = (r << 16) | (g << 8) | b;
      int n; count.TryGetValue(key, out n); count[key] = n + 1;
      if (r >= 250 && g >= 250 && b >= 250) white++;
      sr += r; sg += g; sb += b;
    }
    o["samples"] = samples; o["owned"] = owned; o["distinct"] = count.Count;
    if (owned > 0) {
      int bk = 0, bn = 0; foreach (var kv in count) if (kv.Value > bn) { bn = kv.Value; bk = kv.Key; }
      o["dominantRgb"] = string.Format("{0},{1},{2}", (bk >> 16) & 255, (bk >> 8) & 255, bk & 255);
      o["dominantRatio"] = Math.Round((double)bn / owned, 4);
      o["whiteRatio"] = Math.Round((double)white / owned, 4);
      o["meanRgb"] = string.Format("{0},{1},{2}", sr / owned, sg / owned, sb / owned);
    }
    if (!string.IsNullOrEmpty(save)) {
      using (var img = new Bitmap(w, h, PixelFormat.Format32bppRgb)) {
        var bd = img.LockBits(new Rectangle(0, 0, w, h), ImageLockMode.WriteOnly, PixelFormat.Format32bppRgb);
        Marshal.Copy(buf, 0, bd.Scan0, buf.Length); img.UnlockBits(bd); img.Save(save, ImageFormat.Png);
      }
    }
    o["ms"] = sw.ElapsedMilliseconds;
    return o;
  }
}
'@
$h = [HLPix]::Find([uint32]$ProcessId, $Title)
if ($h -eq [IntPtr]::Zero) { '{"found":false}'; exit 0 }
if ($Raise) { [HLPix]::Raise($h); Start-Sleep -Milliseconds 150 }
$o = [HLPix]::Measure($h, ($Mode -eq 'print'), $Save)
$o['found'] = $true
$o['hwnd'] = $h.ToInt64()
$o | ConvertTo-Json -Compress
