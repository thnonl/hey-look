# QA tooling only (never shipped). Drives Google sign-in / consent in the owner's EXISTING Chrome profile that is already signed in to the
# test account (owner, 2026-11-05: "Hay dung chrome co profile de test vi da login san google"). Default: Chrome profile "Profile 1" =
# thnonline@gmail.com. Chrome refuses a DevTools port on its normal user-data folder, so this script uses UI Automation (the accessibility
# tree Chrome exposes) to read the page and press the buttons. No CDP, no mouse moves, no typing.
#
#   powershell -NoProfile -File scripts\qa\google-consent-profile.ps1 -Check
#       opens the account chooser in that profile and reports whether the test account is signed in there (exit 0 yes, 3 no). Clicks nothing.
#   powershell -NoProfile -File scripts\qa\google-consent-profile.ps1 -Snapshot <file>
#       remembers the Google consent tabs open now (their loopback ports), so -FromUia ignores them later.
#   powershell -NoProfile -File scripts\qa\google-consent-profile.ps1 -Action allow|deny (-Url <consent url> | -FromUia [-Since <file>])
#
# Safety rules (owner, 2026-11-05):
#   - Refuses unless the Chrome profile's signed-in user (Local State, read-only) is exactly -Email (default thnonline@gmail.com).
#   - Clicks ONLY the account tile that names -Email; checks -Email is on the consent page before Continue / Allow. Otherwise it stops.
#   - NEVER types: a password, code, CAPTCHA or "Email or phone" page stops it (exit 3, NEED_OWNER). Stores no credentials.
#   - The app opens its consent URL in the system default browser (the owner's default profile). -FromUia reads that URL from the address bar and
#     opens it again in the test profile; the default-profile tab is left alone (nobody clicks in it).
# Exit codes: 0 done, 2 usage/refused, 3 NEED_OWNER, 4 wrong or missing account (stopped), 5 timeout, 6 other error.
[CmdletBinding()]
param(
  [ValidateSet('allow', 'deny')] [string]$Action,
  [string]$Url,
  [switch]$FromUia,
  [string]$Since,
  [string]$Snapshot,
  [switch]$Check,
  [switch]$KeepTab,
  [string]$Email = 'thnonline@gmail.com',
  [string]$ChromeProfile = 'Profile 1',
  [int]$TimeoutSec = 180
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$AE = [System.Windows.Automation.AutomationElement]
$TS = [System.Windows.Automation.TreeScope]
$CT = [System.Windows.Automation.ControlType]
$Email = $Email.Trim().ToLowerInvariant()

function Log([string]$m) { Write-Output ('{0} {1}' -f (Get-Date -Format 'HH:mm:ss'), $m) }
function Quit([int]$code, [string]$m) { if ($code -eq 0) { Log $m } else { [Console]::Error.WriteLine($m) }; exit $code }

function Get-Chrome {
  foreach ($b in @($env:ProgramFiles, ${env:ProgramFiles(x86)}, $env:LOCALAPPDATA)) {
    if ($b) { $p = Join-Path $b 'Google\Chrome\Application\chrome.exe'; if (Test-Path $p) { return $p } }
  }
  Quit 6 'Chrome not found'
}

# the profile must belong to the test account (read-only look at Local State)
function Assert-Profile {
  $ls = Join-Path $env:LOCALAPPDATA 'Google\Chrome\User Data\Local State'
  $j = Get-Content -Raw -Encoding UTF8 $ls | ConvertFrom-Json
  $info = $j.profile.info_cache.$ChromeProfile
  if (-not $info) { Quit 2 "refused: Chrome profile '$ChromeProfile' does not exist" }
  if (([string]$info.user_name).ToLowerInvariant() -ne $Email) { Quit 2 "refused: Chrome profile '$ChromeProfile' is not signed in to $Email" }
  $script:ProfileName = [string]$info.name
}

# a window of the test profile: Chrome's avatar button carries the profile's name (all profiles share one chrome.exe process, so a pid says nothing)
function Test-ProfileWindow($w) {
  $bc = New-Object System.Windows.Automation.PropertyCondition($AE::ControlTypeProperty, $CT::Button)
  foreach ($b in $w.FindAll($TS::Descendants, $bc)) { try { if ($b.Current.Name -eq $script:ProfileName) { return $true } } catch {} }
  $false
}
# closes the active tab of a window through its own close button (no keys, no mouse)
function Close-ActiveTab($w) {
  $tc = New-Object System.Windows.Automation.PropertyCondition($AE::ControlTypeProperty, $CT::TabItem)
  foreach ($t in $w.FindAll($TS::Descendants, $tc)) {
    $p = $null
    if ($t.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$p) -and $p.Current.IsSelected) {
      $x = $t.FindFirst($TS::Descendants, (New-Object System.Windows.Automation.PropertyCondition($AE::ControlTypeProperty, $CT::Button)))
      $ip = $null; if ($x -and $x.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$ip)) { $ip.Invoke(); return $true }
    }
  }
  $false
}

function Open-InProfile([string]$u) {
  Start-Process -FilePath (Get-Chrome) -ArgumentList @("--profile-directory=`"$ChromeProfile`"", "`"$u`"")
}

# every Chrome address bar now: @{ win = top-level element; url = text }
function Get-Bars {
  $out = @()
  $wc = New-Object System.Windows.Automation.PropertyCondition($AE::ClassNameProperty, 'Chrome_WidgetWin_1')
  foreach ($w in $AE::RootElement.FindAll($TS::Children, $wc)) {
    # Chrome only: Edge, Electron apps and others share the window class
    $pn = ''; try { $pn = (Get-Process -Id $w.Current.ProcessId -ErrorAction Stop).ProcessName } catch {}
    if ($pn -ne 'chrome') { continue }
    $bc = New-Object System.Windows.Automation.PropertyCondition($AE::NameProperty, 'Address and search bar')
    $bar = $null; try { $bar = $w.FindFirst($TS::Descendants, $bc) } catch {}
    if ($bar) { try { $out += [pscustomobject]@{ win = $w; url = [string]$bar.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern).Current.Value } } catch {} }
  }
  $out
}
function Get-LoopPort([string]$u) {
  if ($u -match 'redirect_uri=http(?:%3A|:)(?:%2F%2F|//)127\.0\.0\.1(?:%3A|:)(\d+)') { return $Matches[1] }
  if ($u -match '^(?:http://)?127\.0\.0\.1:(\d+)') { return $Matches[1] }
  ''
}
function Get-ConsentTabs { Get-Bars | Where-Object { $_.url -match 'accounts\.google\.com' -and $_.url -match 'client_id=' -and (Get-LoopPort $_.url) } }

# the page of one window: its buttons, links, check boxes, edits and all names (for the e-mail check)
function Read-Page($win) {
  $doc = $win.FindFirst($TS::Descendants, (New-Object System.Windows.Automation.PropertyCondition($AE::ControlTypeProperty, $CT::Document)))
  if (-not $doc) { return $null }
  $all = $doc.FindAll($TS::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
  $items = foreach ($e in $all) {
    try { [pscustomobject]@{ el = $e; type = $e.Current.ControlType.ProgrammaticName; name = [string]$e.Current.Name; off = $e.Current.IsOffscreen } } catch {}
  }
  [pscustomobject]@{ items = $items; text = (($items | ForEach-Object { $_.name }) -join ' ').ToLowerInvariant() }
}
function Find-Item($page, [string[]]$types, [string]$pattern) {
  $page.items | Where-Object { ($types -contains $_.type) -and $_.name -match $pattern -and -not $_.off } | Select-Object -First 1
}
function Press-El($e) {
  $p = $null
  if ($e.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$p)) { $p.Invoke(); return $true }
  if ($e.TryGetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern, [ref]$p)) { $p.Toggle(); return $true }
  $false
}
# only the element itself is pressed: never a parent (a parent group once picked the wrong account) and never a guess
function Press($item) {
  if (Press-El $item.el) { return $true }
  Log "could not press '$($item.name)' ($($item.type))"; $false
}
# after a press, wait until the address changes (max 10 s), so one page never gets two presses
function Wait-Moved([string]$from) {
  $until = (Get-Date).AddSeconds(10)
  while ((Get-Date) -lt $until) {
    Start-Sleep -Milliseconds 500
    $b = Get-Bars | Where-Object { $_.win.Current.NativeWindowHandle -eq $hwnd } | Select-Object -First 1
    if (-not $b -or $b.url -ne $from) { return }
  }
}

$btn = @('ControlType.Button', 'ControlType.Hyperlink')
$tileTypes = @('ControlType.Hyperlink') # the chooser's account link; never its list item or a parent group
# English and Vietnamese labels (Google follows the account's language, not hl=); the file stays ASCII, so Vietnamese is written as \u escapes
$ReContinue = '^(Continue|Allow|Tiếp tục|Cho phép)$'
$ReCancel = '^(Cancel|Deny|Hủy|Huỷ|Từ chối)$'
$ReAdvanced = '^(Advanced|Nâng cao)$'
$ReGoUnsafe = '^(Go to .*\(unsafe\)|Đi tới .*\(không an toàn\))$'
$ReBackSafe = '^(Back to safety|Quay lại trang an toàn)$'
$ReSelectAll = '^(Select all|Chọn tất cả)'
$emailRe = [regex]::Escape($Email)

# ---- snapshot ----
if ($Snapshot) { $ports = @(Get-ConsentTabs | ForEach-Object { Get-LoopPort $_.url }); ConvertTo-Json -InputObject $ports | Set-Content -Encoding UTF8 $Snapshot; Quit 0 "snapshot: $($ports.Count) consent tab(s) ignored later" }

Assert-Profile

# ---- check: open the chooser in the test profile and look for the account (no click) ----
if ($Check) {
  Open-InProfile 'https://accounts.google.com/AccountChooser?hl=en'
  $end = (Get-Date).AddSeconds(30)
  while ((Get-Date) -lt $end) {
    Start-Sleep -Milliseconds 1500
    foreach ($b in (Get-Bars | Where-Object { $_.url -match 'accounts\.google\.com' -and $_.url -notmatch 'client_id=' -and (Test-ProfileWindow $_.win) })) {
      $pg = Read-Page $b.win
      if ($pg -and $pg.text -match $emailRe) {
        $tile = Find-Item $pg $tileTypes $emailRe
        Quit 0 ("OK: '{0}' shows {1} (tile type {2}); nothing clicked" -f $ChromeProfile, $Email, $(if ($tile) { $tile.type } else { 'none found' }))
      }
    }
  }
  Quit 3 "NEED_OWNER: no $Email on the account chooser in '$ChromeProfile'"
}

if (-not $Action) { Quit 2 'usage: -Check | -Snapshot <file> | -Action allow|deny (-Url <url> | -FromUia [-Since <file>])' }

# ---- get the consent URL ----
if (-not $Url) {
  if (-not $FromUia) { Quit 2 'give -Url or -FromUia' }
  $old = @(); if ($Since -and (Test-Path $Since)) { $old = @(Get-Content -Raw $Since | ConvertFrom-Json) }
  $end = (Get-Date).AddSeconds(60)
  while (-not $Url -and (Get-Date) -lt $end) {
    $fresh = Get-ConsentTabs | Where-Object { $old -notcontains (Get-LoopPort $_.url) } | Select-Object -First 1
    if ($fresh) { $Url = $fresh.url; if ($Url -notmatch '^https?://') { $Url = "https://$Url" } } else { Start-Sleep -Milliseconds 1500 }
  }
  if (-not $Url) { Quit 5 'TIMEOUT: no new Google consent URL in any address bar within 60 s' }
}
$port = Get-LoopPort $Url
if (-not $port) { Quit 2 'not an app consent URL (no 127.0.0.1 redirect)' }
if ($Url -notmatch '[?&]hl=') { $Url = "$Url&hl=en" }
# the window of the test profile whose active tab carries our port. Chrome opens outside links in the LAST USED profile, so the app's own tab
# may already sit in the test profile: then it is driven as it is, with no second copy.
function Find-OurWindow { (Get-Bars | Where-Object { (Get-LoopPort $_.url) -eq $port -and (Test-ProfileWindow $_.win) } | Select-Object -First 1).win }
$win = Find-OurWindow
if ($win) { Log "consent for loopback port $port is already open in Chrome profile '$ChromeProfile'" }
else {
  Log "consent for loopback port $port; opening it in Chrome profile '$ChromeProfile' (a tab in another profile is left untouched)"
  Open-InProfile $Url
  $end = (Get-Date).AddSeconds(30)
  while (-not $win -and (Get-Date) -lt $end) { Start-Sleep -Milliseconds 1000; $win = Find-OurWindow }
}
if (-not $win) { Quit 6 "the consent tab did not appear in a window of profile '$ChromeProfile' (avatar '$script:ProfileName')" }
$hwnd = $win.Current.NativeWindowHandle
Log ("driving window 0x{0:X}" -f $hwnd)

$end = (Get-Date).AddSeconds($TimeoutSec); $last = ''
while ((Get-Date) -lt $end) {
  Start-Sleep -Milliseconds 1500
  $bar = Get-Bars | Where-Object { $_.win.Current.NativeWindowHandle -eq $hwnd } | Select-Object -First 1
  if (-not $bar) { Quit 6 'the test-profile window closed' }
  if ($bar.url -match '^(?:http://)?127\.0\.0\.1:') {
    $err = if ($bar.url -match '[?&]error=([^&]+)') { $Matches[1] } else { '' }
    $res = if ($err) { "refused (error=$err)" } elseif ($bar.url -match '[?&]code=') { 'allowed (code present, not shown)' } else { 'redirect received (the app page hides the outcome; read it in the app)' }
    Start-Sleep -Milliseconds 1500 # the app answers the loopback page first
    $page = ($bar.win.Current.Name -replace ' - Google Chrome$', '') # the app's own page title: "Signed in to Hey Look!" / "Sign-in was cancelled - Hey Look!"
    $res = "$res; app page: '$page'"
    $closed = if ($KeepTab) { 'kept (-KeepTab)' } else { Close-ActiveTab $bar.win }
    Quit 0 "DONE action=$Action -> loopback $port $res; tab closed: $closed"
  }
  $pg = Read-Page $bar.win; if (-not $pg) { continue }
  $sig = ($pg.items | Where-Object { $btn -contains $_.type -and -not $_.off } | Select-Object -First 8 | ForEach-Object { $_.name }) -join ' | '
  if ($sig -ne $last) { Log "page: $sig"; $last = $sig }
  if ($pg.items | Where-Object { $_.type -eq 'ControlType.Edit' -and $_.name -match 'password|code|characters|email or phone' -and -not $_.off }) {
    Quit 3 'NEED_OWNER: Google asks for a password, a code, a CAPTCHA or an e-mail address. Nothing typed.'
  }
  if ($pg.text -match "verify it.s you|2-step verification|captcha") { Quit 3 'NEED_OWNER: Google asks to verify. Nothing typed.' }
  $cont = Find-Item $pg $btn $ReContinue
  $canc = Find-Item $pg $btn $ReCancel
  if (-not $cont -and -not $canc) {
    # the "Google hasn't verified this app" page (it names the developer's address, not the account): known by its two buttons
    $back = Find-Item $pg $btn $ReBackSafe
    if ($back) {
      # (also for deny: "Back to safety" goes to a help page and never answers the app; the refusal is Cancel on the consent page)
      $g = Find-Item $pg $btn $ReGoUnsafe; if ($g) { if (Press $g) { Log "pressed $($g.name)"; Wait-Moved $bar.url }; continue }
      $a = Find-Item $pg $btn $ReAdvanced; if ($a -and (Press $a)) { Log "pressed $($a.name) (unverified-app page)"; Start-Sleep -Milliseconds 800 }
      continue
    }
    if ($bar.url -notmatch 'accountchooser|chooseaccount') { continue } # only the account chooser gets an account press (any language)
    $tile = Find-Item $pg $tileTypes $emailRe
    if ($tile) { if (Press $tile) { Log "pressed the account link '$($tile.name)'"; Wait-Moved $bar.url }; continue }
    $script:miss++; if ($script:miss -ge 4) { Quit 4 "STOP: no account link for $Email on the account chooser; nothing clicked" }
    continue
  }
  # a consent page: it must name the test account
  if ($pg.text -notmatch $emailRe) { Quit 4 "STOP: this consent page does not name $Email; nothing clicked" }
  if ($Action -eq 'deny') { if ($canc -and (Press $canc)) { Log "pressed $($canc.name)"; Wait-Moved $bar.url }; continue }
  $sa = $pg.items | Where-Object { $_.type -eq 'ControlType.CheckBox' -and $_.name -match $ReSelectAll -and -not $_.off } | Select-Object -First 1
  if ($sa) {
    $tp = $null
    if ($sa.el.TryGetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern, [ref]$tp) -and $tp.Current.ToggleState -ne 'On') { $tp.Toggle(); Log 'ticked Select all'; continue }
  }
  if ($cont -and (Press $cont)) { Log "pressed $($cont.name)"; Wait-Moved $bar.url }
}
Quit 5 "TIMEOUT after $TimeoutSec s (last page: $last)"
