# QA kit helper (1.0.11 RC1): sends the picture-rule fixture mails to the test mail server (SMTP) so the kit syncs them. The "sender check" of the app
# reads the TOPMOST Authentication-Results header (authres.rs): the fixtures write one, a server that does not sign mail (GreenMail) never adds its own.
#   A  written-to sender, dmarc=pass            -> pictures show by themselves (needs kit-seed.py --written-to friend@written.example)
#   B  built-in service domain, dkim+dmarc pass -> pictures show by themselves (no-reply@accounts.google.com is in SERVICE_DOMAINS)
#   C  written-to sender, NO Authentication-Results -> pictures stay hidden (Unknown)
#   D  written-to sender, dmarc=fail            -> pictures stay hidden
#   E  a stranger, dmarc=pass                    -> pictures stay hidden (neither written to nor a service)
# Each mail has one remote picture at http://<img host:port>/img/<name>.png (run an image listener there, e.g. E:\hey-mail\test-builds\v1011-wp1\host\img-listener.py).
# usage: python kit-mail.py <smtp host> <smtp port> <image host:port> [--to u1@example.test]
import smtplib, sys, uuid, argparse
from email.message import EmailMessage
from email.utils import formatdate

ap = argparse.ArgumentParser()
ap.add_argument('smtp_host'); ap.add_argument('smtp_port', type=int); ap.add_argument('img')
ap.add_argument('--to', default='u1@example.test')
a = ap.parse_args()

def mail(tag, name, addr, auth, pic):
    m = EmailMessage()
    if auth:
        m['Authentication-Results'] = auth  # (added first so it is the topmost header the server keeps)
    m['Subject'] = f'[QA-1011] {tag}'
    m['From'] = f'{name} <{addr}>'
    m['To'] = a.to
    m['Date'] = formatdate(localtime=False)
    m['Message-ID'] = f'<{uuid.uuid4()}@qa.1011.example>'
    m.set_content('Plain text part for the QA fixture.')
    m.add_alternative(f'<html><body><p>{tag}</p><img alt="{pic}" width="200" height="80" src="http://{a.img}/img/{pic}.png"></body></html>', subtype='html')
    return m

msgs = [
    mail('A written-to sender, DMARC pass', 'Friend', 'friend@written.example', 'mx.qa.example; dmarc=pass header.from=written.example; dkim=pass header.d=written.example', 'auto-written'),
    mail('B service domain, DKIM + DMARC pass', 'Google', 'no-reply@accounts.google.com', 'mx.qa.example; dkim=pass header.d=accounts.google.com; dmarc=pass header.from=accounts.google.com', 'auto-service'),
    mail('C written-to sender, no Authentication-Results', 'Friend', 'friend@written.example', None, 'auto-noauth'),
    mail('D written-to sender, DMARC fail', 'Friend', 'friend@written.example', 'mx.qa.example; dmarc=fail header.from=written.example', 'auto-fail'),
    mail('E stranger, DMARC pass', 'Stranger', 'hello@stranger.example', 'mx.qa.example; dmarc=pass header.from=stranger.example', 'auto-stranger'),
]
with smtplib.SMTP(a.smtp_host, a.smtp_port, timeout=20) as s:
    for m in msgs:
        s.send_message(m)
        print('sent', m['Subject'])
