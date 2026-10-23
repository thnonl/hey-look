# Turns the display off and on again (QA of D-057: "after the display goes off/on"): SC_MONITORPOWER off, a few seconds, then a 1 px mouse move wakes it.
# The power state is the only thing touched; no setting is changed. Usage: powershell -File display-power.ps1 [-Seconds 8]
param([int]$Seconds = 8)
Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices;
public static class HLPower {
  [DllImport("user32.dll")] public static extern IntPtr SendMessageTimeout(IntPtr h, uint msg, IntPtr w, IntPtr l, uint flags, uint timeout, out IntPtr result);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, int dx, int dy, uint data, UIntPtr extra);
}
'@
$r = [IntPtr]::Zero
[void][HLPower]::SendMessageTimeout([IntPtr]0xFFFF, 0x0112, [IntPtr]0xF170, [IntPtr]2, 2, 2000, [ref]$r)
Start-Sleep -Seconds $Seconds
[HLPower]::mouse_event(1, 1, 0, 0, [UIntPtr]::Zero)
Start-Sleep -Milliseconds 200
[HLPower]::mouse_event(1, -1, 0, 0, [UIntPtr]::Zero)
Start-Sleep -Seconds 2
'monitor power cycled'
