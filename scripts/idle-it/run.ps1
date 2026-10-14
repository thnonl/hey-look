# IMAP IDLE integration test (opt-in; CI does not run it). Starts three throw-away servers in Docker, runs
# `cargo test --lib idle_it` against them, removes the containers.
#   GreenMail  (greenmail/standalone:2.1.0)    IMAPS 13993, SMTP 13025   mail is delivered by SMTP
#   Dovecot    (dovecot/dovecot:2.3-latest)    IMAPS 13994               IDLE on, mail is delivered by IMAP APPEND
#   Dovecot    (same image, IDLE not offered)  IMAPS 13995               the polling-fallback case
# Needs Docker and a Rust toolchain. Usage:  powershell -File scripts\idle-it\run.ps1 [-Keep]
param([switch]$Keep)
$ErrorActionPreference = 'Stop'
$here = $PSScriptRoot
$tauri = Join-Path (Split-Path (Split-Path $here)) 'src-tauri'
$names = 'hl-idle-gm', 'hl-idle-dv', 'hl-idle-dv2'

function Remove-All { foreach ($n in $names) { docker rm -f $n 2>$null | Out-Null } }
function Wait-Port([int]$port) {
  for ($i = 0; $i -lt 60; $i++) {
    try { $c = New-Object Net.Sockets.TcpClient('127.0.0.1', $port); $c.Close(); return } catch { Start-Sleep -Seconds 1 }
  }
  throw "port $port did not open"
}
$dovecotStart = 'mkdir -p /tmp/dv /srv/vmail && chown vmail:vmail /srv/vmail && openssl req -x509 -newkey rsa:2048 -nodes -days 2 -subj /CN=127.0.0.1 -keyout /tmp/dv/key.pem -out /tmp/dv/cert.pem 2>/dev/null && exec dovecot -F'

Remove-All
try {
  docker run -d --name hl-idle-gm -p 127.0.0.1:13025:3025 -p 127.0.0.1:13993:3993 `
    -e 'GREENMAIL_OPTS=-Dgreenmail.setup.test.all -Dgreenmail.hostname=0.0.0.0 -Dgreenmail.users=u1:pw1@example.test' greenmail/standalone:2.1.0 | Out-Null
  docker run -d --name hl-idle-dv -p 127.0.0.1:13994:993 -v "${here}\dovecot-idle.conf:/etc/dovecot/dovecot.conf:ro" --entrypoint sh dovecot/dovecot:2.3-latest -c $dovecotStart | Out-Null
  docker run -d --name hl-idle-dv2 -p 127.0.0.1:13995:993 -v "${here}\dovecot-noidle.conf:/etc/dovecot/dovecot.conf:ro" --entrypoint sh dovecot/dovecot:2.3-latest -c $dovecotStart | Out-Null
  13993, 13025, 13994, 13995 | ForEach-Object { Wait-Port $_ }
  Start-Sleep -Seconds 5   # GreenMail opens its ports before it accepts logins

  $env:HEYLOOK_IDLE_IT = '1'; $env:HL_IT_USER = 'u1'; $env:HL_IT_PASS = 'pw1'; $env:HL_IT_NOIDLE_PORT = '13995'
  Push-Location $tauri
  Write-Host '=== GreenMail: new mail by SMTP ==='
  $env:HL_IT_PORT = '13993'; $env:HL_IT_SMTP_PORT = '13025'; $env:HL_IT_CONTAINER = 'hl-idle-gm'
  cargo test --lib idle_it -- --test-threads=1 --nocapture; $a = $LASTEXITCODE
  Write-Host '=== Dovecot: new mail by IMAP APPEND ==='
  $env:HL_IT_PORT = '13994'; Remove-Item Env:HL_IT_SMTP_PORT; $env:HL_IT_CONTAINER = 'hl-idle-dv'
  cargo test --lib idle_it -- --test-threads=1 --nocapture; $b = $LASTEXITCODE
  Pop-Location
  if ($a -ne 0 -or $b -ne 0) { throw "integration tests failed (GreenMail $a, Dovecot $b)" }
  Write-Host 'IDLE integration tests passed (GreenMail and Dovecot).'
} finally {
  if (-not $Keep) { Remove-All }
}
