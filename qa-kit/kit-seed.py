# QA kit helper (1.0.11 RC1): writes the data folder of a kit run BEFORE the kit is started on it (refuses an existing heylook.db).
# One mailbox on a test mail server (GreenMail), the password in qa-secrets.json (the kit has the qa-secrets feature), optional rows the kit cannot get by clicking:
#   --name-same           display name == address (the calendar "X . X" row of WP5-c)
#   --written-to a,b      addresses the mailbox "has written to" (table written_to): with a DMARC/DKIM-passing mail from one of them the automatic picture rule fires
# usage: python kit-seed.py <data folder> [--imap-port 33993 --imaps --tls-insecure --smtp-port 33025 --smtp-security none]
#        [--email u1@example.test --user u1 --password pw1 --name "QA One" | --name-same] [--written-to friend@written.example]
import argparse, json, os, sqlite3

ap = argparse.ArgumentParser()
ap.add_argument('folder')
ap.add_argument('--imap-host', default='127.0.0.1'); ap.add_argument('--imap-port', type=int, default=33993)
ap.add_argument('--imaps', action='store_true', help='IMAP over TLS (needed: the app connects only with SSL/TLS or STARTTLS)')
ap.add_argument('--tls-insecure', action='store_true', help='accept the self-signed certificate of the test server')
ap.add_argument('--smtp-host', default='127.0.0.1'); ap.add_argument('--smtp-port', type=int, default=33025)
ap.add_argument('--smtp-security', default='none', choices=['none', 'starttls', 'ssl'])
ap.add_argument('--email', default='u1@example.test'); ap.add_argument('--user', default='u1'); ap.add_argument('--password', default='pw1')
ap.add_argument('--name', default='QA One'); ap.add_argument('--name-same', action='store_true')
ap.add_argument('--written-to', default='')
ap.add_argument('--id', default='qa-1011-acc1')
a = ap.parse_args()

os.makedirs(a.folder, exist_ok=True)
db_path = os.path.join(a.folder, 'heylook.db')
if os.path.exists(db_path):
    raise SystemExit('refusing to overwrite an existing seed: ' + db_path)
name = a.email if a.name_same else a.name
c = sqlite3.connect(db_path)
c.executescript("""
CREATE TABLE accounts(
  id TEXT PRIMARY KEY, email TEXT NOT NULL, display_name TEXT NOT NULL,
  imap_host TEXT NOT NULL, imap_port INTEGER NOT NULL, imap_ssl INTEGER NOT NULL,
  smtp_host TEXT NOT NULL, smtp_port INTEGER NOT NULL, smtp_security TEXT NOT NULL,
  username TEXT NOT NULL
);
ALTER TABLE accounts ADD COLUMN tls_insecure INTEGER NOT NULL DEFAULT 0;
CREATE TABLE IF NOT EXISTS written_to(email TEXT NOT NULL COLLATE NOCASE, account_id TEXT NOT NULL, PRIMARY KEY(email, account_id));
""")
c.execute('INSERT INTO accounts(id,email,display_name,imap_host,imap_port,imap_ssl,smtp_host,smtp_port,smtp_security,username,tls_insecure) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
          (a.id, a.email, name, a.imap_host, a.imap_port, 1 if a.imaps else 0, a.smtp_host, a.smtp_port, a.smtp_security, a.user, 1 if a.tls_insecure else 0))
for w in [x.strip() for x in a.written_to.split(',') if x.strip()]:
    c.execute('INSERT OR IGNORE INTO written_to(email, account_id) VALUES(?,?)', (w, a.id))
c.commit(); c.close()
with open(os.path.join(a.folder, 'qa-secrets.json'), 'w', encoding='utf-8') as f:
    json.dump({'heylook.qa\x01' + a.id: a.password, 'heylook.qa\x01' + a.id + ':smtp': a.password}, f, indent=2)
print('seed written:', a.folder, 'display name:', repr(name), 'written_to:', a.written_to or '-')
