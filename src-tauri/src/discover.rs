//! Find IMAP / SMTP settings for an email address, in this order:
//! 1. built-in presets (no network), 2. the provider's own autoconfig XML and the Thunderbird ISPDB,
//! 3. DNS SRV records (RFC 6186), 4. the MX host (presets, then ISPDB for the MX domain), 5. probing common host names.
//! Only the domain (and the address in the autoconfig query, as Thunderbird does) leaves the machine.
use crate::db::{err, R};
use hickory_resolver::proto::rr::RData;
use hickory_resolver::TokioResolver;
use serde::Serialize;
use std::io::Read;
use std::net::{TcpStream, ToSocketAddrs};
use std::time::Duration;

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Discovered {
    pub imap_host: String,
    pub imap_port: u16,
    pub imap_ssl: bool,
    pub smtp_host: String,
    pub smtp_port: u16,
    /// "ssl" | "starttls"
    pub smtp_security: String,
    pub username: String,
    /// "google" | "microsoft" when the host supports a sign-in window instead of a password
    pub oauth: Option<String>,
    /// "built-in" | "autoconfig" | "ispdb" | "dns-srv" | "mx" | "guess"
    pub source: String,
}

fn valid_host(h: &str) -> bool {
    !h.is_empty() && h.len() <= 253 && h.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '.') && !h.starts_with('.') && !h.starts_with('-')
}

/// (local part, domain) of an address; the domain is lowercased and must look like a host name.
fn split(email: &str) -> R<(String, String)> {
    let e = email.trim();
    let (local, domain) = e.rsplit_once('@').ok_or("EMAIL_INVALID: Enter a valid email address")?;
    let domain = domain.to_lowercase();
    if local.is_empty() || !domain.contains('.') || !valid_host(&domain) {
        return Err("EMAIL_INVALID: Enter a valid email address".into());
    }
    Ok((local.to_string(), domain))
}

fn oauth_for(imap_host: &str) -> Option<String> {
    let h = imap_host.to_lowercase();
    if h.ends_with("gmail.com") || h.ends_with("googlemail.com") {
        Some("google".into())
    } else if h.ends_with("office365.com") || h.ends_with("outlook.com") {
        Some("microsoft".into())
    } else {
        None
    }
}

fn found(imap: (&str, u16, bool), smtp: (&str, u16, &str), username: &str, source: &str) -> Discovered {
    Discovered {
        imap_host: imap.0.into(),
        imap_port: imap.1,
        imap_ssl: imap.2,
        smtp_host: smtp.0.into(),
        smtp_port: smtp.1,
        smtp_security: smtp.2.into(),
        username: username.into(),
        oauth: oauth_for(imap.0),
        source: source.into(),
    }
}

const GOOGLE: ((&str, u16, bool), (&str, u16, &str)) = (("imap.gmail.com", 993, true), ("smtp.gmail.com", 465, "ssl"));
const MICROSOFT: ((&str, u16, bool), (&str, u16, &str)) = (("outlook.office365.com", 993, true), ("smtp.office365.com", 587, "starttls"));

fn builtin(domain: &str, email: &str) -> Option<Discovered> {
    let (imap, smtp) = match domain {
        "gmail.com" | "googlemail.com" => GOOGLE,
        "outlook.com" | "hotmail.com" | "live.com" | "msn.com" | "windowslive.com" => MICROSOFT,
        "icloud.com" | "me.com" | "mac.com" => (("imap.mail.me.com", 993, true), ("smtp.mail.me.com", 587, "starttls")),
        "yahoo.com" | "ymail.com" | "rocketmail.com" => (("imap.mail.yahoo.com", 993, true), ("smtp.mail.yahoo.com", 465, "ssl")),
        _ => return None,
    };
    Some(found(imap, smtp, email, "built-in"))
}

/// Domains hosted by Google Workspace or Microsoft 365 are recognised by their MX host.
fn builtin_by_mx(mx_host: &str, email: &str) -> Option<Discovered> {
    let h = mx_host.to_lowercase();
    let (imap, smtp) = if h.ends_with("google.com") || h.ends_with("googlemail.com") {
        GOOGLE
    } else if h.ends_with("mail.protection.outlook.com") || h.ends_with("outlook.com") {
        MICROSOFT
    } else {
        return None;
    };
    Some(found(imap, smtp, email, "mx"))
}

// ---------- autoconfig XML (Mozilla format) ----------

fn child_text(n: roxmltree::Node, name: &str) -> Option<String> {
    n.children().find(|c| c.has_tag_name(name)).and_then(|c| c.text()).map(|t| t.trim().to_string())
}

/// Best server of `kind` ("imap" / "smtp"): implicit TLS first, then STARTTLS. Plain text is never used.
fn pick_server(doc: &roxmltree::Document, tag: &str, kind: &str) -> Option<(String, u16, bool, String)> {
    doc.descendants()
        .filter(|n| n.has_tag_name(tag) && n.attribute("type") == Some(kind))
        .filter_map(|n| {
            let host = child_text(n, "hostname")?;
            let port = child_text(n, "port")?.parse::<u16>().ok()?;
            let ssl = match child_text(n, "socketType")?.to_uppercase().as_str() {
                "SSL" => true,
                "STARTTLS" => false,
                _ => return None,
            };
            Some((host, port, ssl, child_text(n, "username").unwrap_or_default()))
        })
        .min_by_key(|(_, _, ssl, _)| !*ssl)
}

fn parse_autoconfig(xml: &str, email: &str, source: &str) -> Option<Discovered> {
    let (local, domain) = split(email).ok()?;
    let expand = |t: &str| {
        t.replace("%EMAILADDRESS%", email).replace("%EMAILLOCALPART%", &local).replace("%EMAILDOMAIN%", &domain)
    };
    // roxmltree refuses DOCTYPE declarations, so entity-expansion tricks are rejected
    let doc = roxmltree::Document::parse(xml).ok()?;
    let (ihost, iport, issl, iuser) = pick_server(&doc, "incomingServer", "imap")?;
    let (shost, sport, sssl, _) = pick_server(&doc, "outgoingServer", "smtp")?;
    let (ihost, shost) = (expand(&ihost), expand(&shost));
    if !valid_host(&ihost) || !valid_host(&shost) {
        return None;
    }
    let username = Some(expand(&iuser)).filter(|u| !u.is_empty()).unwrap_or_else(|| email.to_string());
    Some(Discovered {
        oauth: oauth_for(&ihost),
        imap_host: ihost,
        imap_port: iport,
        imap_ssl: issl,
        smtp_host: shost,
        smtp_port: sport,
        smtp_security: if sssl { "ssl" } else { "starttls" }.into(),
        username,
        source: source.into(),
    })
}

fn fetch_text(url: &str) -> Option<String> {
    // HTTPS only, including after redirects
    let policy = reqwest::redirect::Policy::custom(|a| {
        if a.url().scheme() == "https" && a.previous().len() < 3 { a.follow() } else { a.stop() }
    });
    let client = reqwest::blocking::Client::builder().timeout(Duration::from_secs(5)).redirect(policy).build().ok()?;
    let resp = client.get(url).send().ok()?;
    if !resp.status().is_success() {
        return None;
    }
    let mut body = String::new();
    resp.take(256 * 1024).read_to_string(&mut body).ok()?;
    Some(body)
}

fn fetch_ispdb(lookup_domain: &str, email: &str) -> Option<Discovered> {
    let xml = fetch_text(&format!("https://autoconfig.thunderbird.net/v1.1/{lookup_domain}"))?;
    parse_autoconfig(&xml, email, "ispdb")
}

/// The provider's own autoconfig URLs and the ISPDB are queried together; the first hit in this order wins.
fn fetch_autoconfig(domain: &str, email: &str) -> Option<Discovered> {
    let q = urlencoding::encode(email).into_owned();
    let urls = [
        format!("https://autoconfig.{domain}/mail/config-v1.1.xml?emailaddress={q}"),
        format!("https://{domain}/.well-known/autoconfig/mail/config-v1.1.xml?emailaddress={q}"),
    ];
    std::thread::scope(|s| {
        let own: Vec<_> = urls.iter().map(|u| s.spawn(move || fetch_text(u).and_then(|x| parse_autoconfig(&x, email, "autoconfig")))).collect();
        let ispdb = s.spawn(|| fetch_ispdb(domain, email));
        own.into_iter().filter_map(|h| h.join().ok().flatten()).next().or_else(|| ispdb.join().ok().flatten())
    })
}

// ---------- DNS ----------

async fn srv_best(r: &TokioResolver, name: String) -> Option<(String, u16)> {
    let lookup = r.srv_lookup(name).await.ok()?;
    let mut v: Vec<_> = lookup
        .answers()
        .iter()
        .filter_map(|rec| match &rec.data {
            RData::SRV(s) => Some((s.priority, std::cmp::Reverse(s.weight), s.port, s.target.to_utf8())),
            _ => None,
        })
        .collect();
    v.sort();
    let (_, _, port, target) = v.into_iter().next()?;
    let host = target.trim_end_matches('.').to_string();
    (port != 0 && valid_host(&host)).then_some((host, port)) // "." target = service not offered
}

async fn srv(r: &TokioResolver, domain: &str, email: &str) -> Option<Discovered> {
    let (imap, imap_ssl) = match srv_best(r, format!("_imaps._tcp.{domain}.")).await {
        Some(x) => (x, true),
        None => (srv_best(r, format!("_imap._tcp.{domain}.")).await?, false),
    };
    let (smtp, smtp_sec) = match srv_best(r, format!("_submissions._tcp.{domain}.")).await {
        Some(x) => (x, "ssl"),
        None => (srv_best(r, format!("_submission._tcp.{domain}.")).await?, "starttls"),
    };
    Some(Discovered {
        oauth: oauth_for(&imap.0),
        imap_host: imap.0,
        imap_port: imap.1,
        imap_ssl,
        smtp_host: smtp.0,
        smtp_port: smtp.1,
        smtp_security: smtp_sec.into(),
        username: email.to_string(),
        source: "dns-srv".into(),
    })
}

/// Host of the best (lowest preference) MX record.
async fn mx_host(r: &TokioResolver, domain: &str) -> Option<String> {
    let lookup = r.mx_lookup(format!("{domain}.")).await.ok()?;
    let mut v: Vec<_> = lookup
        .answers()
        .iter()
        .filter_map(|rec| match &rec.data {
            RData::MX(m) => Some((m.preference, m.exchange.to_utf8())),
            _ => None,
        })
        .collect();
    v.sort();
    let host = v.into_iter().next()?.1.trim_end_matches('.').to_lowercase();
    valid_host(&host).then_some(host)
}

/// "a.b.example.com" -> ["b.example.com", "example.com"]: the parents worth looking up in the ISPDB.
fn parent_domains(host: &str) -> Vec<String> {
    let labels: Vec<&str> = host.split('.').collect();
    (1..labels.len().saturating_sub(1)).map(|i| labels[i..].join(".")).collect()
}

// ---------- probing ----------

fn open(host: &str, port: u16) -> bool {
    (host, port)
        .to_socket_addrs()
        .ok()
        .and_then(|mut a| a.next())
        .is_some_and(|a| TcpStream::connect_timeout(&a, Duration::from_secs(3)).is_ok())
}

/// Last resort: common host names with an open IMAPS / SMTP port. Not verified, so the UI flags it.
fn guess(domain: &str, email: &str) -> Option<Discovered> {
    let imap_hosts = [format!("imap.{domain}"), format!("mail.{domain}")];
    let smtp_hosts = [format!("smtp.{domain}"), format!("mail.{domain}")];
    std::thread::scope(|s| {
        let imap: Vec<_> = imap_hosts.iter().map(|h| s.spawn(move || open(h, 993))).collect();
        let smtp: Vec<_> = smtp_hosts.iter().flat_map(|h| [465u16, 587].map(|p| (h, p))).map(|(h, p)| (h, p, s.spawn(move || open(h, p)))).collect();
        let imap_ok: Vec<bool> = imap.into_iter().map(|h| h.join().unwrap_or(false)).collect();
        let imap_host = imap_hosts.iter().zip(imap_ok).find(|(_, ok)| *ok).map(|(h, _)| h.clone())?;
        let (smtp_host, smtp_port) = smtp
            .into_iter()
            .map(|(h, p, t)| (h, p, t.join().unwrap_or(false)))
            .find(|(_, _, ok)| *ok)
            .map(|(h, p, _)| (h.clone(), p))?;
        Some(Discovered {
            oauth: None,
            imap_host,
            imap_port: 993,
            imap_ssl: true,
            smtp_host,
            smtp_port,
            smtp_security: if smtp_port == 465 { "ssl" } else { "starttls" }.into(),
            username: email.to_string(),
            source: "guess".into(),
        })
    })
}

pub async fn run(email: &str) -> R<Option<Discovered>> {
    let email = email.trim().to_string();
    let (_, domain) = split(&email)?;
    if let Some(d) = builtin(&domain, &email) {
        return Ok(Some(d));
    }
    let (d1, e1) = (domain.clone(), email.clone());
    if let Some(d) = crate::blocking(move || Ok(fetch_autoconfig(&d1, &e1))).await? {
        return Ok(Some(d));
    }
    // DNS needs the system resolver; if it cannot be set up the later steps still run
    if let Ok(builder) = TokioResolver::builder_tokio() {
        if let Ok(resolver) = builder.build() {
            if let Some(d) = srv(&resolver, &domain, &email).await {
                return Ok(Some(d));
            }
            if let Some(mx) = mx_host(&resolver, &domain).await {
                if let Some(d) = builtin_by_mx(&mx, &email) {
                    return Ok(Some(d));
                }
                let (parents, e2) = (parent_domains(&mx), email.clone());
                let hit = crate::blocking(move || Ok(parents.iter().find_map(|p| fetch_ispdb(p, &e2)))).await?;
                if let Some(mut d) = hit {
                    d.source = "mx".into();
                    return Ok(Some(d));
                }
            }
        }
    }
    let (d3, e3) = (domain, email);
    crate::blocking(move || Ok(guess(&d3, &e3))).await.map_err(err)
}

#[cfg(test)]
mod tests {
    use super::*;

    const XML: &str = r#"<?xml version="1.0"?>
<clientConfig version="1.1"><emailProvider id="example.com">
 <incomingServer type="imap"><hostname>imap.%EMAILDOMAIN%</hostname><port>143</port><socketType>STARTTLS</socketType><username>%EMAILLOCALPART%</username></incomingServer>
 <incomingServer type="imap"><hostname>imap.example.com</hostname><port>993</port><socketType>SSL</socketType><username>%EMAILLOCALPART%</username></incomingServer>
 <incomingServer type="pop3"><hostname>pop.example.com</hostname><port>995</port><socketType>SSL</socketType></incomingServer>
 <outgoingServer type="smtp"><hostname>smtp.example.com</hostname><port>587</port><socketType>STARTTLS</socketType></outgoingServer>
</emailProvider></clientConfig>"#;

    #[test]
    fn autoconfig_prefers_implicit_tls_and_expands_username() {
        let d = parse_autoconfig(XML, "nam@example.com", "autoconfig").unwrap();
        assert_eq!((d.imap_host.as_str(), d.imap_port, d.imap_ssl), ("imap.example.com", 993, true));
        assert_eq!((d.smtp_host.as_str(), d.smtp_port, d.smtp_security.as_str()), ("smtp.example.com", 587, "starttls"));
        assert_eq!(d.username, "nam");
        assert_eq!(d.oauth, None);
    }

    #[test]
    fn autoconfig_rejects_plain_text_and_doctype() {
        let plain = XML.replace("STARTTLS", "plain").replace(">SSL<", ">plain<");
        assert!(parse_autoconfig(&plain, "nam@example.com", "x").is_none());
        let doctype = format!("<!DOCTYPE x [<!ENTITY a \"b\">]>{XML}");
        assert!(parse_autoconfig(&doctype, "nam@example.com", "x").is_none());
    }

    #[test]
    fn rejects_bad_hosts_and_addresses() {
        assert!(split("nam").is_err());
        assert!(split("nam@localhost").is_err());
        assert!(split("nam@exa mple.com").is_err());
        assert_eq!(split("Nam@Example.COM").unwrap().1, "example.com");
        let evil = XML.replace("smtp.example.com", "smtp.example.com/../x");
        assert!(parse_autoconfig(&evil, "nam@example.com", "x").is_none());
    }

    #[test]
    fn presets_and_mx() {
        assert_eq!(builtin("gmail.com", "a@gmail.com").unwrap().oauth.as_deref(), Some("google"));
        assert_eq!(builtin("hotmail.com", "a@hotmail.com").unwrap().oauth.as_deref(), Some("microsoft"));
        assert!(builtin("example.com", "a@example.com").is_none());
        assert_eq!(builtin_by_mx("aspmx.l.google.com", "a@corp.io").unwrap().imap_host, "imap.gmail.com");
        assert_eq!(builtin_by_mx("corp-io.mail.protection.outlook.com", "a@corp.io").unwrap().oauth.as_deref(), Some("microsoft"));
        assert_eq!(parent_domains("mx1.mail.example.com"), vec!["mail.example.com", "example.com"]);
    }
}
