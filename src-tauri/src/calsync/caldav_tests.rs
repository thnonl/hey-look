//! Contract tests of the CalDAV client against a fake server that answers the way Radicale, sabre/dav (Baikal, Nextcloud), iCloud and Fastmail do (canned multistatus bodies, real
//! sync tokens, ctags and etags). No real account, nothing leaves 127.0.0.1.
use super::super::engine::{self, Clock};
use super::super::fake_http::{FakeServer, Req, Resp};
use super::super::store::{self, tests::{conn, ACC}};
use super::super::{Kind, ProviderFactory};
use super::*;
use crate::lock;
use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};

const USER: &str = "qa1";
const PASS: &str = "app-secret";

fn basic(user: &str, pass: &str) -> String {
    use base64_lite::encode;
    format!("Basic {}", encode(format!("{user}:{pass}").as_bytes()))
}

/// a tiny base64 (the tests need it for one header; no crate for that)
mod base64_lite {
    pub fn encode(b: &[u8]) -> String {
        const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        let mut out = String::new();
        for c in b.chunks(3) {
            let n = (c[0] as u32) << 16 | (*c.get(1).unwrap_or(&0) as u32) << 8 | *c.get(2).unwrap_or(&0) as u32;
            out.push(T[(n >> 18) as usize & 63] as char);
            out.push(T[(n >> 12) as usize & 63] as char);
            out.push(if c.len() > 1 { T[(n >> 6) as usize & 63] as char } else { '=' });
            out.push(if c.len() > 2 { T[n as usize & 63] as char } else { '=' });
        }
        out
    }
}

struct Coll {
    path: String,
    name: String,
    color: Option<String>,
    writable: bool,
    comps: Option<Vec<&'static str>>,
    /// resource name -> (etag, ical text)
    res: BTreeMap<String, (String, String)>,
    /// (token number, resource name, removed)
    changes: Vec<(u64, String, bool)>,
    token: u64,
    ctag: u64,
    /// the sync-collection answer ends after this many resources with a 507 (the server sends it in parts)
    part: Option<usize>,
}

impl Coll {
    fn new(path: &str, name: &str) -> Coll {
        Coll { path: path.into(), name: name.into(), color: None, writable: true, comps: None, res: BTreeMap::new(), changes: vec![], token: 0, ctag: 1, part: None }
    }
}

struct World {
    colls: Vec<Coll>,
    /// the server offers sync tokens and the sync-collection report
    sync: bool,
    /// the server sends invitations itself
    scheduling: bool,
    /// the sync tokens it knows from before this number are forgotten (valid-sync-token error)
    forget_before: u64,
    wrong_auth_header: Option<&'static str>,
    log: Vec<String>,
    /// where the principal is asked for
    root_answers: bool,
    well_known: Option<String>,
    multiget_sizes: Vec<usize>,
    etag_seq: u64,
    /// answers at /remote.php/dav/ like Nextcloud
    nc: bool,
    /// (method, If-Match, If-None-Match) of every write
    conds: Vec<(String, String, String)>,
    /// a PUT answers without an ETag header (sabre/dav when it changed the text)
    put_no_etag: bool,
    /// the next PUT with If-None-Match answers 412 (the name is taken)
    first_put_412: bool,
    /// a PUT answers 403 need-privileges
    deny_writes: bool,
    /// what a PUT answers 403 or 415 with, when set
    put_error: Option<(u16, &'static str)>,
}

const HOME: &str = "/calendars/qa1/";

fn world() -> World {
    World { colls: vec![Coll::new("/calendars/qa1/work/", "Work")], sync: true, scheduling: false, forget_before: 0, wrong_auth_header: None, log: vec![], root_answers: false, well_known: Some("/".into()), multiget_sizes: vec![], etag_seq: 0, nc: false, conds: vec![], put_no_etag: false, first_put_412: false, deny_writes: false, put_error: None }
}

fn ev(uid: &str, summary: &str, extra: &str) -> String {
    format!("BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//t//EN\r\nBEGIN:VEVENT\r\nUID:{uid}\r\nDTSTAMP:20261001T080000Z\r\nDTSTART:20261020T090000Z\r\nDTEND:20261020T100000Z\r\nSUMMARY:{summary}\r\n{extra}END:VEVENT\r\nEND:VCALENDAR\r\n")
}

fn put(w: &mut World, coll: usize, name: &str, raw: String) {
    w.etag_seq += 1;
    let etag = format!("\"e{}\"", w.etag_seq);
    let c = &mut w.colls[coll];
    c.token += 1;
    c.ctag += 1;
    c.changes.push((c.token, name.to_string(), false));
    c.res.insert(name.to_string(), (etag, raw));
}

fn remove(w: &mut World, coll: usize, name: &str) {
    let c = &mut w.colls[coll];
    c.token += 1;
    c.ctag += 1;
    c.res.remove(name);
    c.changes.push((c.token, name.to_string(), true));
}

fn ms(inner: &str) -> Resp {
    Resp { status: 207, headers: vec![("Content-Type".into(), "application/xml; charset=utf-8".into())], body: format!(r#"<?xml version="1.0"?><D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav" xmlns:CS="http://calendarserver.org/ns/" xmlns:A="http://apple.com/ns/ical/">{inner}</D:multistatus>"#) }
}

fn prop_response(href: &str, props: &str) -> String {
    format!("<D:response><D:href>{href}</D:href><D:propstat><D:prop>{props}</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>")
}

fn hrefs_in(body: &str) -> Vec<String> {
    body.split("<D:href>").skip(1).filter_map(|s| s.split("</D:href>").next()).map(|s| s.replace("&amp;", "&")).collect()
}

fn handle(w: &Arc<Mutex<World>>, r: &Req, host: &str) -> Resp {
    let mut g = w.lock().unwrap();
    let depth = r.headers.get("depth").cloned().unwrap_or_default();
    g.log.push(format!("{} {} d={} auth={}", r.method, r.path(), depth, r.headers.contains_key("authorization")));
    if r.headers.get("authorization").map(String::as_str) != Some(basic(USER, PASS).as_str()) {
        let h = g.wrong_auth_header.unwrap_or("Basic realm=\"x\"");
        return Resp::empty(401).with("WWW-Authenticate", h);
    }
    let path = r.path().to_string();
    let body = r.body.clone();
    match (r.method.as_str(), path.as_str()) {
        ("PROPFIND", "/.well-known/caldav") => match g.well_known.clone() {
            Some(to) if to != "/" => Resp::empty(301).with("Location", &format!("http://{host}{to}")),
            Some(_) => principal(host),
            None => Resp::empty(404),
        },
        ("PROPFIND", "/") if g.root_answers => principal(host),
        ("PROPFIND", "/dav.php/") => principal(host),
        ("PROPFIND", "/remote.php/dav/") if g.nc => principal(host),
        ("PROPFIND", "/principals/qa1/") => ms(&prop_response("/principals/qa1/", &format!(r#"<C:calendar-home-set><D:href>{HOME}</D:href></C:calendar-home-set><C:calendar-user-address-set><D:href>mailto:qa1@example.test</D:href><D:href>/principals/qa1/</D:href></C:calendar-user-address-set><D:displayname>QA One</D:displayname>"#))),
        ("OPTIONS", p) if p == HOME => {
            let dav = if g.scheduling { "1, 3, calendar-access, calendar-auto-schedule" } else { "1, 3, calendar-access" };
            Resp::empty(200).with("DAV", dav)
        }
        ("PROPFIND", p) if p == HOME => {
            let mut inner = prop_response(HOME, "<D:resourcetype><D:collection/></D:resourcetype>");
            for c in &g.colls {
                inner.push_str(&collection_response(c, g.sync));
            }
            ms(&inner)
        }
        ("PROPFIND", p) if g.colls.iter().any(|c| c.path == p) => {
            let c = g.colls.iter().find(|c| c.path == p).unwrap();
            if depth == "1" {
                // the etags of every resource
                let mut inner = prop_response(&c.path, "<D:resourcetype><D:collection/></D:resourcetype>");
                for (name, (etag, _)) in &c.res {
                    inner.push_str(&prop_response(&format!("{}{name}", c.path), &format!("<D:getetag>{etag}</D:getetag><D:resourcetype/>")));
                }
                ms(&inner)
            } else if body.contains("current-user-principal") || body.contains("getctag") && body.contains("resourcetype") || body.contains("displayname") {
                ms(&collection_response(c, g.sync))
            } else {
                let mut props = format!("<CS:getctag>ctag-{}</CS:getctag>", c.ctag);
                if g.sync {
                    props.push_str(&format!("<D:sync-token>http://x/sync/{}</D:sync-token><D:supported-report-set><D:supported-report><D:report><D:sync-collection/></D:report></D:supported-report></D:supported-report-set>", c.token));
                }
                ms(&prop_response(&c.path, &props))
            }
        }
        ("REPORT", p) if g.colls.iter().any(|c| c.path == p) => {
            let idx = g.colls.iter().position(|c| c.path == p).unwrap();
            if body.contains("sync-collection") {
                if !g.sync {
                    return Resp::empty(501);
                }
                let given = body.split("<D:sync-token>").nth(1).and_then(|s| s.split("</D:sync-token>").next()).map(|t| t.rsplit('/').next().unwrap_or("0").parse::<u64>().unwrap_or(0));
                let forget = g.forget_before;
                if given.is_some_and(|t| t < forget) {
                    return Resp { status: 403, headers: vec![], body: r#"<D:error xmlns:D="DAV:"><D:valid-sync-token/></D:error>"#.into() };
                }
                let c = &g.colls[idx];
                let since = given.unwrap_or(0);
                // the latest change of every resource since the token
                let mut latest: Vec<(String, bool)> = vec![];
                for (t, name, removed) in &c.changes {
                    if *t > since {
                        latest.retain(|(n, _)| n != name);
                        latest.push((name.clone(), *removed));
                    }
                }
                let mut inner = String::new();
                let (shown, partial) = match c.part {
                    Some(n) if latest.len() > n => (&latest[..n], true),
                    _ => (&latest[..], false),
                };
                for (name, removed) in shown {
                    let href = format!("{}{name}", c.path);
                    if *removed {
                        inner.push_str(&format!("<D:response><D:href>{href}</D:href><D:status>HTTP/1.1 404 Not Found</D:status></D:response>"));
                    } else {
                        inner.push_str(&prop_response(&href, &format!("<D:getetag>{}</D:getetag>", c.res[name].0)));
                    }
                }
                let new_token = if partial {
                    // a token that covers what was sent so far
                    let upto = c.changes.iter().filter(|(_, n, _)| shown.iter().any(|(s, _)| s == n)).map(|(t, _, _)| *t).max().unwrap_or(since);
                    inner.push_str(&format!("<D:response><D:href>{}</D:href><D:status>HTTP/1.1 507 Insufficient Storage</D:status></D:response>", c.path));
                    // (the next call starts after the last resource sent: the fake drops the rest into the next round by moving the token to just before the first unsent change)
                    let first_unsent = latest[shown.len()].0.clone();
                    c.changes.iter().filter(|(_, n, _)| *n == first_unsent).map(|(t, _, _)| *t).min().map(|t| t - 1).unwrap_or(upto)
                } else {
                    c.token
                };
                let mut resp = ms(&inner);
                resp.body = resp.body.replace("</D:multistatus>", &format!("<D:sync-token>http://x/sync/{new_token}</D:sync-token></D:multistatus>"));
                resp
            } else if body.contains("calendar-multiget") {
                let wanted = hrefs_in(&body);
                g.multiget_sizes.push(wanted.len());
                let c = &g.colls[idx];
                let mut inner = String::new();
                for h in wanted {
                    let name = h.trim_start_matches(&c.path).to_string();
                    match c.res.get(&name) {
                        Some((etag, raw)) => inner.push_str(&prop_response(&h, &format!("<D:getetag>{etag}</D:getetag><C:calendar-data>{}</C:calendar-data>", xml_escape(raw)))),
                        None => inner.push_str(&format!("<D:response><D:href>{h}</D:href><D:status>HTTP/1.1 404 Not Found</D:status></D:response>")),
                    }
                }
                ms(&inner)
            } else {
                Resp::empty(400)
            }
        }
        ("GET", p) if locate(&g, p).is_some() => {
            let (i, name) = locate(&g, p).unwrap();
            match g.colls[i].res.get(&name) {
                Some((etag, raw)) => Resp { status: 200, headers: vec![("Content-Type".into(), "text/calendar; charset=utf-8".into()), ("ETag".into(), etag.clone())], body: raw.clone() },
                None => Resp::empty(404),
            }
        }
        ("PUT", p) if locate(&g, p).is_some() => {
            let (i, name) = locate(&g, p).unwrap();
            let im = r.headers.get("if-match").cloned().unwrap_or_default();
            let inm = r.headers.get("if-none-match").cloned().unwrap_or_default();
            g.conds.push(("PUT".into(), im.clone(), inm.clone()));
            if g.deny_writes || !g.colls[i].writable {
                return Resp { status: 403, headers: vec![], body: r#"<D:error xmlns:D="DAV:"><D:need-privileges/></D:error>"#.into() };
            }
            if let Some((status, body)) = g.put_error {
                return Resp { status, headers: vec![], body: body.into() };
            }
            if inm == "*" && (g.colls[i].res.contains_key(&name) || g.first_put_412) {
                g.first_put_412 = false;
                return Resp::empty(412);
            }
            if !im.is_empty() && g.colls[i].res.get(&name).map(|(e, _)| e.as_str()) != Some(im.as_str()) {
                return Resp::empty(412);
            }
            if !body.contains("BEGIN:VCALENDAR") {
                return Resp { status: 403, headers: vec![], body: r#"<D:error xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav"><C:valid-calendar-data/></D:error>"#.into() };
            }
            let existed = g.colls[i].res.contains_key(&name);
            put(&mut g, i, &name, body.clone());
            let etag = g.colls[i].res[&name].0.clone();
            let mut resp = Resp::empty(if existed { 204 } else { 201 });
            if !g.put_no_etag {
                resp = resp.with("ETag", &etag);
            }
            resp
        }
        ("MKCALENDAR", p) if p.starts_with(HOME) && p.ends_with('/') && p.len() > HOME.len() => {
            let name = body.split("<D:displayname>").nth(1).and_then(|s| s.split("</D:displayname>").next()).unwrap_or("New").to_string();
            g.conds.push(("MKCALENDAR".into(), String::new(), String::new()));
            if g.deny_writes {
                return Resp::empty(403);
            }
            g.colls.push(Coll::new(p, &name));
            Resp::empty(201)
        }
        ("DELETE", p) if locate(&g, p).is_some() => {
            let (i, name) = locate(&g, p).unwrap();
            let im = r.headers.get("if-match").cloned().unwrap_or_default();
            g.conds.push(("DELETE".into(), im.clone(), String::new()));
            if g.deny_writes {
                return Resp { status: 403, headers: vec![], body: r#"<D:error xmlns:D="DAV:"><D:need-privileges/></D:error>"#.into() };
            }
            match g.colls[i].res.get(&name).map(|(e, _)| e.clone()) {
                None => Resp::empty(404),
                Some(e) if !im.is_empty() && e != im => Resp::empty(412),
                Some(_) => {
                    remove(&mut g, i, &name);
                    Resp::empty(204)
                }
            }
        }
        ("PROPFIND", p) if locate(&g, p).is_some() => {
            let (i, name) = locate(&g, p).unwrap();
            match g.colls[i].res.get(&name) {
                Some((etag, _)) => ms(&prop_response(p, &format!("<D:getetag>{etag}</D:getetag>"))),
                None => Resp::empty(404),
            }
        }
        (_, p) if g.colls.iter().any(|c| c.path == p) => Resp::empty(405),
        _ => Resp::empty(404),
    }
}

/// The collection and the resource name a path points at (a path inside a collection, one level down).
fn locate(g: &World, path: &str) -> Option<(usize, String)> {
    g.colls.iter().position(|c| path.starts_with(&c.path) && path.len() > c.path.len() && !path[c.path.len()..].contains('/')).map(|i| (i, path[g.colls[i].path.len()..].to_string()))
}

fn principal(_host: &str) -> Resp {
    ms(&prop_response("/", "<D:current-user-principal><D:href>/principals/qa1/</D:href></D:current-user-principal>"))
}

fn xml_escape(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
}

fn collection_response(c: &Coll, sync: bool) -> String {
    let mut props = String::from("<D:resourcetype><D:collection/><C:calendar/></D:resourcetype>");
    props.push_str(&format!("<D:displayname>{}</D:displayname>", c.name));
    if let Some(col) = &c.color {
        props.push_str(&format!("<A:calendar-color>{col}</A:calendar-color>"));
    }
    props.push_str(&format!("<D:current-user-privilege-set><D:privilege><D:read/></D:privilege>{}</D:current-user-privilege-set>", if c.writable { "<D:privilege><D:write-content/></D:privilege>" } else { "" }));
    props.push_str(&format!("<CS:getctag>ctag-{}</CS:getctag>", c.ctag));
    if sync {
        props.push_str(&format!("<D:sync-token>http://x/sync/{}</D:sync-token><D:supported-report-set><D:supported-report><D:report><D:sync-collection/></D:report></D:supported-report></D:supported-report-set>", c.token));
    }
    if let Some(comps) = &c.comps {
        props.push_str(&format!("<C:supported-calendar-component-set>{}</C:supported-calendar-component-set>", comps.iter().map(|x| format!("<C:comp name=\"{x}\"/>")).collect::<String>()));
    }
    prop_response(&c.path, &props)
}

struct Env {
    srv: FakeServer,
    w: Arc<Mutex<World>>,
}

fn serve(w: World) -> Env {
    let w = Arc::new(Mutex::new(w));
    let w2 = w.clone();
    let srv = FakeServer::start(move |r: &Req| {
        let host = r.headers.get("host").cloned().unwrap_or_default();
        handle(&w2, r, &host)
    });
    Env { srv, w }
}

fn http(env: &Env, preset: Preset) -> DavHttp {
    DavHttp::new(&Url::parse(&env.srv.base).unwrap(), USER, PASS, preset, false)
}

fn dav_source(env: &Env, found: &Discovered) -> DavSource {
    DavSource { url: env.srv.base.clone(), username: USER.into(), preset: Preset::Other, homes: found.homes.clone(), addresses: found.addresses.clone(), scheduling: found.scheduling, trust_cert: false }
}

fn log(env: &Env) -> Vec<String> {
    env.w.lock().unwrap().log.clone()
}

// ---------------------------------------------------------------- discovery

#[test]
fn discovery_finds_the_calendars_by_the_well_known_path_with_names_colours_and_rights() {
    let mut w = world();
    w.colls[0].color = Some("#FF8800FF".into());
    let mut ro = Coll::new("/calendars/qa1/family/", "Family");
    ro.writable = false;
    w.colls.push(ro);
    // a task list and a calendar without a declared component set
    let mut tasks = Coll::new("/calendars/qa1/tasks/", "Tasks");
    tasks.comps = Some(vec!["VTODO"]);
    w.colls.push(tasks);
    let mut both = Coll::new("/calendars/qa1/both/", "Both");
    both.comps = Some(vec!["VEVENT", "VTODO"]);
    w.colls.push(both);
    w.scheduling = true;
    let env = serve(w);
    let d = discover(&http(&env, Preset::Other), &env.srv.base, Preset::Other).unwrap();
    assert_eq!(d.homes, vec![format!("{}{HOME}", env.srv.base.trim_end_matches('/'))]);
    assert_eq!(d.addresses, vec!["qa1@example.test", "/principals/qa1/"].into_iter().filter(|a| a.contains('@')).map(String::from).collect::<Vec<_>>());
    let names: Vec<(&str, &str, bool)> = d.calendars.iter().map(|c| (c.name.as_str(), c.color.as_str(), c.read_only)).collect();
    assert_eq!(names, vec![("Work", "#ff8800", false), ("Family", "", true), ("Both", "", false)], "no task list; the colour without its alpha; the read-only one marked");
    assert!(d.scheduling, "calendar-auto-schedule in the DAV header");
    let l = log(&env);
    assert!(l.iter().all(|x| x.ends_with("auth=true")), "every request carried the credentials: {l:?}");
}

#[test]
fn a_server_that_answers_at_its_root_and_one_with_the_calendar_url_itself_are_found() {
    // path 1: the address entered is the DAV root (a Baikal style address): the principal is asked there first
    let mut w = world();
    w.well_known = None;
    let env = serve(w);
    let base = format!("{}/dav.php/", env.srv.base);
    let d = discover(&http(&env, Preset::Other), &base, Preset::Other).unwrap();
    assert_eq!(d.calendars.len(), 1);
    assert!(log(&env)[0].starts_with("PROPFIND /dav.php/"), "{:?}", log(&env));
    // path 2: nothing at the .well-known path, the root answers
    let mut w = world();
    w.well_known = None;
    w.root_answers = true;
    let env = serve(w);
    assert_eq!(discover(&http(&env, Preset::Other), &env.srv.base, Preset::Other).unwrap().calendars.len(), 1);
    // path 3: the Nextcloud fallback
    let mut w = world();
    w.well_known = None;
    w.nc = true;
    let env = serve(w);
    assert_eq!(discover(&http(&env, Preset::Nextcloud), &env.srv.base, Preset::Nextcloud).unwrap().calendars.len(), 1);
    assert!(log(&env).iter().any(|l| l.starts_with("PROPFIND /remote.php/dav/")), "{:?}", log(&env));
    // path 5: no principal, the URL is a calendar collection
    let mut w = world();
    w.well_known = None;
    let env = serve(w);
    let url = format!("{}/calendars/qa1/work/", env.srv.base);
    let d = discover(&http(&env, Preset::Other), &url, Preset::Other).unwrap();
    assert_eq!((d.homes.len(), d.calendars.len(), d.calendars[0].name.as_str()), (0, 1, "Work"));
}

#[test]
fn discovery_errors_are_sorted_into_the_sentences_of_the_dialog() {
    let env = serve(world());
    // 401: wrong password
    let bad = DavHttp::new(&Url::parse(&env.srv.base).unwrap(), USER, "nope", Preset::Other, false);
    assert_eq!(discover(&bad, &env.srv.base, Preset::Other).unwrap_err(), DavErr::Auth);
    assert_eq!(DavErr::Auth.connect_text(), "CAL_DAV_AUTH: Couldn’t sign in to the calendar server. Check the username and the password.");
    // a server that offers only Digest
    let mut w = world();
    w.wrong_auth_header = Some("Digest realm=\"x\", nonce=\"1\"");
    let env2 = serve(w);
    let bad = DavHttp::new(&Url::parse(&env2.srv.base).unwrap(), USER, "nope", Preset::Other, false);
    assert_eq!(discover(&bad, &env2.srv.base, Preset::Other).unwrap_err(), DavErr::AuthMethod);
    // no server: a port nobody listens on
    let port = { std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port() };
    let base = format!("http://127.0.0.1:{port}/");
    let h = DavHttp::new(&Url::parse(&base).unwrap(), USER, PASS, Preset::Other, false);
    assert_eq!(discover(&h, &base, Preset::Other).unwrap_err(), DavErr::NoServer);
    assert!(DavErr::NoServer.connect_text().starts_with("CAL_DAV_NOT_FOUND: No server answered at this address."));
    // an address that answers, but not with CalDAV (404 everywhere)
    let mut w = world();
    w.well_known = None;
    let env3 = serve(w);
    let base = format!("{}/nope/", env3.srv.base);
    let h = DavHttp::new(&Url::parse(&base).unwrap(), USER, PASS, Preset::Other, false);
    assert_eq!(discover(&h, &base, Preset::Other).unwrap_err(), DavErr::NotCalDav);
    assert_eq!(DavErr::NotCalDav.connect_text(), "CAL_DAV_NOT_CALDAV: This address doesn’t offer CalDAV calendars.");
    // a user with no calendar
    let mut w = world();
    w.colls.clear();
    let env4 = serve(w);
    assert_eq!(discover(&http(&env4, Preset::Other), &env4.srv.base, Preset::Other).unwrap_err(), DavErr::NoCalendars);
    assert_eq!(DavErr::NoCalendars.connect_text(), "CAL_DAV_NO_CALENDARS: This account has no calendars on the server.");
    // http:// is only for this machine: a remote address without https is refused before anything is sent
    let h = DavHttp::new(&Url::parse("http://cloud.example.com/").unwrap(), USER, PASS, Preset::Other, false);
    assert_eq!(discover(&h, "http://cloud.example.com/", Preset::Other).unwrap_err(), DavErr::Https);
    assert_eq!(DavErr::Https.connect_text(), "CAL_DAV_HTTPS: Use an address that starts with https://.");
    // the texts the dialog maps (every code has its sentence in BACKEND_ERRORS)
    assert_eq!(DavErr::Cert.connect_text(), "CAL_DAV_CERT: The server’s certificate isn’t trusted.");
    assert_eq!(DavErr::AuthMethod.connect_text(), "CAL_DAV_AUTH_METHOD: The server asks for a sign-in method that Hey Look! doesn’t support.");
    assert_eq!(DavErr::Redirect("127.0.0.2".into()).connect_text(), "CAL_DAV_REDIRECT: The server sent Hey Look! to another address (127.0.0.2). Hey Look! stopped there to keep your password safe.");
}

#[test]
fn credentials_go_only_where_the_person_pointed() {
    // a redirect to another host: refused, and the other host never sees the Authorization header
    let seen: Arc<Mutex<Vec<(String, bool)>>> = Arc::default();
    let s2 = seen.clone();
    let elsewhere = FakeServer::start(move |r: &Req| {
        s2.lock().unwrap().push((r.path().to_string(), r.headers.contains_key("authorization")));
        Resp::empty(207)
    });
    let target = elsewhere.base.replace("127.0.0.1", "localhost");
    let t2 = target.clone();
    let first = FakeServer::start(move |_r: &Req| Resp::empty(301).with("Location", &format!("{t2}/steal")));
    let h = DavHttp::new(&Url::parse(&first.base).unwrap(), USER, PASS, Preset::Other, false);
    let e = h.call("PROPFIND", &Url::parse(&first.base).unwrap(), Some("0"), Some("<x/>")).unwrap_err();
    assert!(matches!(&e, DavErr::Redirect(host) if host == "localhost"), "{e:?}");
    assert!(seen.lock().unwrap().is_empty(), "the other host got no request at all: {:?}", seen.lock().unwrap());
    // the same host (a different path, the .well-known redirect) is followed, with the credentials
    let same = FakeServer::start(|r: &Req| {
        if r.path() == "/.well-known/caldav" {
            Resp::empty(301).with("Location", "/dav/")
        } else {
            assert!(r.headers.contains_key("authorization"));
            ms(&prop_response("/dav/", "<D:displayname>x</D:displayname>"))
        }
    });
    let h = DavHttp::new(&Url::parse(&same.base).unwrap(), USER, PASS, Preset::Other, false);
    let r = h.call("PROPFIND", &Url::parse(&format!("{}/.well-known/caldav", same.base)).unwrap(), Some("0"), None).unwrap();
    assert_eq!(r.url.path(), "/dav/");
    // https -> http is never followed (the "http" here is a fake host: only the decision counts)
    let plain = FakeServer::start(|_r: &Req| Resp::empty(200));
    let p2 = plain.base.clone();
    let down = FakeServer::start(move |_r: &Req| Resp::empty(302).with("Location", &p2));
    // (this server is plain http itself: the downgrade rule is about an https origin, covered by `allowed`)
    let h = DavHttp::new(&Url::parse("https://cloud.example.com/").unwrap(), USER, PASS, Preset::Other, false);
    assert!(!h.allowed(&Url::parse("http://cloud.example.com/x").unwrap()), "http is not allowed for a remote host");
    assert!(!h.allowed(&Url::parse("https://other.example.com/x").unwrap()));
    assert!(h.allowed(&Url::parse("https://CLOUD.example.com/x").unwrap()), "the same host, whatever its case");
    let _ = down;
    // a preset's host family: iCloud answers from p45-caldav.icloud.com; nothing else
    let ic = DavHttp::new(&Url::parse("https://caldav.icloud.com/").unwrap(), USER, PASS, Preset::Icloud, false);
    assert!(ic.allowed(&Url::parse("https://p45-caldav.icloud.com/123/").unwrap()));
    assert!(!ic.allowed(&Url::parse("https://icloud.com.evil.example/").unwrap()));
    assert!(!ic.allowed(&Url::parse("https://caldav.fastmail.com/").unwrap()));
    let fm = DavHttp::new(&Url::parse("https://caldav.fastmail.com/").unwrap(), USER, PASS, Preset::Fastmail, false);
    assert!(fm.allowed(&Url::parse("https://d1234.caldav.fastmail.com/dav/").unwrap()));
    assert!(!fm.allowed(&Url::parse("https://notfastmail.com/").unwrap()));
    // a home the server names on another host is not followed for an ordinary server
    let mut w = world();
    w.colls.clear();
    let env = serve(w);
    let h = http(&env, Preset::Other);
    assert!(matches!(resolved(&h, &Url::parse(&env.srv.base).unwrap(), "http://localhost:1/calendars/"), Err(DavErr::Redirect(host)) if host == "localhost"));
    assert!(resolved(&h, &Url::parse(&env.srv.base).unwrap(), "/calendars/qa1/").is_ok());
}

#[test]
fn a_self_signed_certificate_is_refused_unless_the_person_trusts_it() {
    // a TLS server with a throw-away certificate (made when the test runs)
    use std::io::{Read, Write};
    let made = rcgen::generate_simple_self_signed(vec!["localhost".to_string(), "127.0.0.1".to_string()]).unwrap();
    let key = rustls::pki_types::PrivateKeyDer::try_from(made.signing_key.serialize_der()).unwrap();
    let provider = Arc::new(rustls::crypto::aws_lc_rs::default_provider());
    let cfg = Arc::new(rustls::ServerConfig::builder_with_provider(provider).with_safe_default_protocol_versions().unwrap().with_no_client_auth().with_single_cert(vec![made.cert.der().clone()], key).unwrap());
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    std::thread::spawn(move || {
        for s in listener.incoming().flatten() {
            let cfg = cfg.clone();
            std::thread::spawn(move || {
                let mut tls = rustls::StreamOwned::new(rustls::ServerConnection::new(cfg).unwrap(), s);
                let mut buf = [0u8; 4096];
                if tls.read(&mut buf).unwrap_or(0) > 0 {
                    let body = r#"<?xml version="1.0"?><D:multistatus xmlns:D="DAV:"><D:response><D:href>/</D:href><D:propstat><D:prop><D:displayname>x</D:displayname></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response></D:multistatus>"#;
                    let _ = write!(tls, "HTTP/1.1 207 Multi-Status\r\nContent-Type: application/xml\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
                    let _ = tls.flush();
                }
            });
        }
    });
    let url = Url::parse(&format!("https://127.0.0.1:{port}/")).unwrap();
    let strict = DavHttp::new(&url, USER, PASS, Preset::Other, false);
    assert_eq!(strict.call("PROPFIND", &url, Some("0"), None).unwrap_err(), DavErr::Cert);
    let trusting = DavHttp::new(&url, USER, PASS, Preset::Other, true);
    assert_eq!(trusting.call("PROPFIND", &url, Some("0"), None).unwrap().status, 207);
}

// ---------------------------------------------------------------- sync

fn pull_req(state: Option<&str>, known: Option<Vec<(String, String)>>) -> PullReq {
    PullReq { state: state.map(String::from), window_from: 0, window_to: 1, known }
}

fn setup(env: &Env) -> (CalDavProvider, RemoteCalendar) {
    let d = discover(&http(env, Preset::Other), &env.srv.base, Preset::Other).unwrap();
    let p = CalDavProvider::new(dav_source(env, &d), PASS, "qa1@example.test");
    let cal = p.list_calendars().unwrap().remove(0);
    (p, cal)
}

#[test]
fn the_first_download_and_the_next_rounds_use_the_sync_token_and_download_only_what_changed() {
    let mut w = world();
    for i in 0..3 {
        put(&mut w, 0, &format!("e{i}.ics"), ev(&format!("uid-{i}"), &format!("Event {i}"), ""));
    }
    let env = serve(w);
    let (p, cal) = setup(&env);
    let first = p.pull(&cal, &pull_req(None, None)).unwrap();
    assert!(first.full);
    assert_eq!(first.upserts.len(), 3);
    assert!(first.next_state.as_deref().is_some_and(|s| s.starts_with("S:")), "{:?}", first.next_state);
    assert_eq!(first.resources.len(), 3, "the server's text is kept");
    assert!(first.resources[0].raw.contains("BEGIN:VEVENT") && first.resources[0].href.ends_with(".ics"));
    // nothing changed: one REPORT sync-collection, no multiget
    let before = log(&env).len();
    let again = p.pull(&cal, &pull_req(first.next_state.as_deref(), None)).unwrap();
    assert!(!again.full && again.upserts.is_empty() && again.removed.is_empty());
    let new: Vec<String> = log(&env)[before..].to_vec();
    assert_eq!(new.iter().filter(|l| l.starts_with("REPORT")).count(), 1, "{new:?}");
    assert!(env.w.lock().unwrap().multiget_sizes.len() == 1, "only the first download asked for data");
    // a change, a new resource and a deletion on the server
    {
        let mut g = env.w.lock().unwrap();
        put(&mut g, 0, "e1.ics", ev("uid-1", "Event 1 changed", ""));
        put(&mut g, 0, "e9.ics", ev("uid-9", "Event 9", ""));
        remove(&mut g, 0, "e2.ics");
    }
    let next = p.pull(&cal, &pull_req(again.next_state.as_deref(), None)).unwrap();
    let mut titles: Vec<&str> = next.upserts.iter().map(|e| e.summary.as_str()).collect();
    titles.sort();
    assert_eq!(titles, vec!["Event 1 changed", "Event 9"]);
    assert_eq!(next.removed.len(), 1);
    assert!(next.removed[0].ends_with("e2.ics"));
    assert_eq!(next.replace.len(), 2);
}

#[test]
fn a_token_the_server_forgot_means_a_full_download_without_an_error_state() {
    let mut w = world();
    put(&mut w, 0, "a.ics", ev("a", "A", ""));
    let env = serve(w);
    let (p, cal) = setup(&env);
    let first = p.pull(&cal, &pull_req(None, None)).unwrap();
    {
        let mut g = env.w.lock().unwrap();
        put(&mut g, 0, "b.ics", ev("b", "B", ""));
        g.forget_before = 1000;
    }
    assert_eq!(p.pull(&cal, &pull_req(first.next_state.as_deref(), None)).unwrap_err(), SyncErr::Gone, "the engine downloads again");
    // through the engine: the round ends in ok, with both events, no duplicate
    let c = conn();
    let src = store::create_dav_source(&c, ACC, chrono::Utc::now().timestamp(), &dav_source(&env, &Discovered::default())).unwrap();
    assert_eq!(src.kind, Kind::CalDav);
    let db: crate::Db = Arc::new(Mutex::new(c));
    struct F(CalDavProvider);
    impl ProviderFactory for F {
        fn provider(&self, _: &store::Source) -> Result<Box<dyn CalProvider>, SyncErr> {
            let d = discover(&self.0.http, &self.0.src.url, Preset::Other).map_err(|e| e.sync_err())?;
            Ok(Box::new(CalDavProvider::new(DavSource { homes: d.homes, ..self.0.src.clone() }, PASS, "qa1@example.test")))
        }
    }
    let f = F(CalDavProvider::new(dav_source(&env, &Discovered::default()), PASS, "qa1@example.test"));
    let report = engine::sync_source(&db, &f, &src.id, Clock { now: 1_800_000_000, jitter: 0.5 }, &|| {}).unwrap();
    assert_eq!(report.status, "ok", "{report:?}");
    let n = |sql: &str| -> i64 { lock(&db).query_row(sql, [], |r| r.get(0)).unwrap() };
    assert_eq!(n("SELECT COUNT(*) FROM events WHERE remote_id IS NOT NULL"), 2);
    assert_eq!(n("SELECT COUNT(*) FROM cal_resources"), 2, "the server's text is stored with the rows");
    // forget the token on the server side: the next round starts again and nothing is duplicated
    env.w.lock().unwrap().forget_before = 1_000_000;
    let report = engine::sync_source(&db, &f, &src.id, Clock { now: 1_800_000_300, jitter: 0.5 }, &|| {}).unwrap();
    assert_eq!(report.status, "ok", "{report:?}");
    assert_eq!(n("SELECT COUNT(*) FROM events WHERE remote_id IS NOT NULL"), 2);
    let _ = first;
}

#[test]
fn a_report_the_server_sends_in_parts_is_followed_to_its_end() {
    let mut w = world();
    for i in 0..5 {
        put(&mut w, 0, &format!("e{i}.ics"), ev(&format!("u{i}"), &format!("E{i}"), ""));
    }
    w.colls[0].part = Some(2);
    let env = serve(w);
    let (p, cal) = setup(&env);
    let got = p.pull(&cal, &pull_req(None, None)).unwrap();
    assert_eq!(got.upserts.len(), 5, "all five came, in three parts");
    assert_eq!(log(&env).iter().filter(|l| l.starts_with("REPORT")).count() >= 4, true);
}

#[test]
fn a_server_without_sync_tokens_uses_the_ctag_and_downloads_only_changed_etags() {
    let mut w = world();
    w.sync = false;
    for i in 0..3 {
        put(&mut w, 0, &format!("e{i}.ics"), ev(&format!("u{i}"), &format!("E{i}"), ""));
    }
    let env = serve(w);
    let (p, cal) = setup(&env);
    let first = p.pull(&cal, &pull_req(None, None)).unwrap();
    assert!(first.full && first.upserts.len() == 3);
    let state = first.next_state.clone().unwrap();
    assert!(state.starts_with("C:ctag-"), "{state}");
    let known: Vec<(String, String)> = first.resources.iter().map(|r| (r.href.clone(), r.etag.clone())).collect();
    // unchanged: one PROPFIND on the collection, no multiget
    let before = env.w.lock().unwrap().multiget_sizes.len();
    let same = p.pull(&cal, &pull_req(Some(&state), Some(known.clone()))).unwrap();
    assert!(same.upserts.is_empty() && same.removed.is_empty() && same.next_state.as_deref() == Some(state.as_str()));
    assert_eq!(env.w.lock().unwrap().multiget_sizes.len(), before, "no multiget when the ctag is the same");
    // a change and a deletion: the etags are listed, the changed one is downloaded, the missing one is removed
    {
        let mut g = env.w.lock().unwrap();
        put(&mut g, 0, "e0.ics", ev("u0", "E0 changed", ""));
        remove(&mut g, 0, "e1.ics");
    }
    let next = p.pull(&cal, &pull_req(Some(&state), Some(known))).unwrap();
    assert_eq!(next.upserts.iter().map(|e| e.summary.as_str()).collect::<Vec<_>>(), vec!["E0 changed"]);
    assert_eq!(next.removed.len(), 1);
    assert!(next.removed[0].ends_with("e1.ics"));
    assert_eq!(env.w.lock().unwrap().multiget_sizes.last(), Some(&1), "only the changed resource");
}

#[test]
fn many_resources_are_downloaded_in_batches_of_50() {
    let mut w = world();
    for i in 0..120 {
        put(&mut w, 0, &format!("r{i:03}.ics"), ev(&format!("u{i}"), &format!("R{i}"), ""));
    }
    let env = serve(w);
    let (p, cal) = setup(&env);
    let got = p.pull(&cal, &pull_req(None, None)).unwrap();
    assert_eq!(got.upserts.len(), 120);
    assert_eq!(env.w.lock().unwrap().multiget_sizes, vec![50, 50, 20]);
}

#[test]
fn a_401_during_sync_is_access_ended_and_busy_answers_back_off() {
    let mut w = world();
    put(&mut w, 0, "a.ics", ev("a", "A", ""));
    let env = serve(w);
    let (_, cal) = setup(&env);
    let wrong = CalDavProvider::new(DavSource { url: env.srv.base.clone(), username: USER.into(), preset: Preset::Other, homes: vec![format!("{}{HOME}", env.srv.base.trim_end_matches('/'))], addresses: vec![], scheduling: false, trust_cert: false }, "changed-on-the-server", "qa1@example.test");
    assert_eq!(wrong.pull(&cal, &pull_req(None, None)).unwrap_err(), SyncErr::Auth);
    assert_eq!(wrong.list_calendars().unwrap_err(), SyncErr::Auth);
    assert_eq!(DavErr::Busy(Some(Duration::from_secs(30))).sync_err(), SyncErr::RateLimited(Some(Duration::from_secs(30))));
    assert_eq!(DavErr::NoServer.sync_err(), SyncErr::Offline);
    assert_eq!(DavErr::Gone.sync_err(), SyncErr::NotFound, "a calendar that is gone is dropped by the engine");
    // 503 with Retry-After from the server
    let busy = FakeServer::start(|_r: &Req| Resp::empty(503).with("Retry-After", "120"));
    let h = DavHttp::new(&Url::parse(&busy.base).unwrap(), USER, PASS, Preset::Other, false);
    assert_eq!(h.call("REPORT", &Url::parse(&busy.base).unwrap(), Some("0"), None).unwrap_err(), DavErr::Busy(Some(Duration::from_secs(120))));
}

// ---------------------------------------------------------------- mapping

fn me() -> Vec<String> {
    vec!["qa1@example.test".to_string()]
}

#[test]
fn a_series_with_an_override_and_an_exdate_and_a_cancelled_override_maps_to_master_and_exceptions() {
    let raw = "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:s1\r\nDTSTART:20261013T070000Z\r\nDTEND:20261013T080000Z\r\nRRULE:FREQ=WEEKLY;COUNT=5\r\nEXDATE:20261103T070000Z\r\nSUMMARY:Weekly\r\nBEGIN:VALARM\r\nACTION:DISPLAY\r\nTRIGGER:-PT30M\r\nEND:VALARM\r\nEND:VEVENT\r\n\
BEGIN:VEVENT\r\nUID:s1\r\nRECURRENCE-ID:20261020T070000Z\r\nDTSTART:20261020T090000Z\r\nDTEND:20261020T100000Z\r\nSUMMARY:Weekly (moved)\r\nEND:VEVENT\r\n\
BEGIN:VEVENT\r\nUID:s1\r\nRECURRENCE-ID:20261027T070000Z\r\nDTSTART:20261027T070000Z\r\nDTEND:20261027T080000Z\r\nSTATUS:CANCELLED\r\nSUMMARY:Weekly\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n";
    let m = map_resource("http://s/c/s1.ics", "\"e1\"", raw, &me()).unwrap();
    assert_eq!(m.uid, "s1");
    assert_eq!(m.events.len(), 3);
    let master = &m.events[0];
    assert_eq!((master.id.as_str(), master.kind, master.series_id.as_deref(), master.rrule.as_deref(), master.reminder_min), ("http://s/c/s1.ics", EventKind::Master, None, Some("FREQ=WEEKLY;COUNT=5"), Some(30)));
    assert_eq!(master.exdates.len(), 1);
    let moved = &m.events[1];
    assert_eq!((moved.kind, moved.series_id.as_deref(), moved.recurrence_id), (EventKind::Exception, Some("http://s/c/s1.ics"), Some(1_792_479_600)));
    assert!(moved.id.starts_with("http://s/c/s1.ics#"));
    assert_eq!(m.events[2].status, "cancelled");
    // through the store: master + moved one + the cancelled slot as a tombstone; the next pull of the resource replaces all of it
    let c = conn();
    let src = store::create_dav_source(&c, ACC, 1, &DavSource { url: "http://s/".into(), username: "qa1".into(), preset: Preset::Other, homes: vec![], addresses: vec![], scheduling: false, trust_cert: false }).unwrap();
    let cal = RemoteCalendar { id: "http://s/c/".into(), name: "C".into(), selected: true, ..Default::default() };
    store::reconcile_calendars(&c, &src, &[cal]).unwrap();
    let row = store::calendars_of(&c, &src.id).unwrap().remove(0);
    let pull = Pull { upserts: m.events.clone(), replace: vec!["http://s/c/s1.ics".into()], resources: vec![RawResource { href: "http://s/c/s1.ics".into(), etag: "\"e1\"".into(), uid: "s1".into(), raw: raw.into() }], next_state: Some("S:1".into()), full: true, ..Default::default() };
    store::apply_pull(&c, &row, ACC, &pull, Some(0), 100).unwrap();
    let list = crate::calendar::list_range(&c, 1_700_000_000, 1_900_000_000).unwrap();
    // 5 occurrences: 13 Oct, 20 Oct (moved), 27 Oct (cancelled), 3 Nov (EXDATE), 10 Nov -> 3 shown
    assert_eq!(list.len(), 3, "{:?}", list.iter().map(|e| (e.summary.clone(), e.start)).collect::<Vec<_>>());
    assert!(list.iter().any(|e| e.summary == "Weekly (moved)"));
    assert!(list.iter().all(|e| e.read_only.is_none()));
    // the override is removed on the server: the resource is downloaded again without it, and the row is gone, not stale
    let without = raw.replace("BEGIN:VEVENT\r\nUID:s1\r\nRECURRENCE-ID:20261020T070000Z\r\nDTSTART:20261020T090000Z\r\nDTEND:20261020T100000Z\r\nSUMMARY:Weekly (moved)\r\nEND:VEVENT\r\n", "");
    let m2 = map_resource("http://s/c/s1.ics", "\"e2\"", &without, &me()).unwrap();
    let pull2 = Pull { upserts: m2.events, replace: vec!["http://s/c/s1.ics".into()], resources: vec![RawResource { href: "http://s/c/s1.ics".into(), etag: "\"e2\"".into(), uid: "s1".into(), raw: without }], next_state: Some("S:2".into()), ..Default::default() };
    store::apply_pull(&c, &row, ACC, &pull2, None, 200).unwrap();
    let list = crate::calendar::list_range(&c, 1_700_000_000, 1_900_000_000).unwrap();
    assert!(list.iter().all(|e| e.summary == "Weekly"), "{:?}", list.iter().map(|e| e.summary.clone()).collect::<Vec<_>>());
    assert_eq!(list.len(), 3, "20 Oct is a normal occurrence again");
    assert_eq!(c.query_row::<String, _, _>("SELECT etag FROM cal_resources", [], |r| r.get(0)).unwrap(), "\"e2\"");
    // a deleted resource goes with its overrides and its text
    store::apply_pull(&c, &row, ACC, &Pull { removed: vec!["http://s/c/s1.ics".into()], next_state: Some("S:3".into()), ..Default::default() }, None, 300).unwrap();
    assert!(crate::calendar::list_range(&c, 0, 2_000_000_000).unwrap().is_empty());
    assert_eq!(c.query_row::<i64, _, _>("SELECT COUNT(*) FROM cal_resources", [], |r| r.get(0)).unwrap(), 0);
}

#[test]
fn rights_organizers_and_my_own_answer_decide_what_can_be_changed() {
    let mine = "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:m\r\nDTSTART:20261020T090000Z\r\nDTEND:20261020T100000Z\r\nSUMMARY:Mine\r\nORGANIZER:mailto:QA1@example.test\r\nATTENDEE;PARTSTAT=ACCEPTED:mailto:qa1@example.test\r\nATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:bao@x.y\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n";
    let theirs = "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:t\r\nDTSTART:20261020T090000Z\r\nDTEND:20261020T100000Z\r\nSUMMARY:Theirs\r\nORGANIZER;CN=Mai:mailto:mai@x.y\r\nATTENDEE;PARTSTAT=TENTATIVE:mailto:qa1@example.test\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n";
    let plain = ev("p", "Plain", "");
    let a = &map_resource("http://s/m.ics", "\"1\"", mine, &me()).unwrap().events[0];
    assert_eq!((a.my_status.as_deref(), a.can_edit, a.organizer.as_ref().map(|o| o.email.as_str())), (Some("organizer"), true, Some("qa1@example.test")));
    let b = &map_resource("http://s/t.ics", "\"1\"", theirs, &me()).unwrap().events[0];
    assert_eq!((b.my_status.as_deref(), b.can_edit), (Some("tentative"), false), "somebody else's meeting is read only (organizer)");
    let c = &map_resource("http://s/p.ics", "\"1\"", &plain, &me()).unwrap().events[0];
    assert!((c.my_status.is_none(), c.can_edit, c.organizer.is_none()) == (true, true, true));
    // a resource that is not an event (a task) or garbage is not shown and not an error
    assert!(map_resource("http://s/x.ics", "\"1\"", "BEGIN:VCALENDAR\r\nBEGIN:VTODO\r\nUID:x\r\nSUMMARY:todo\r\nEND:VTODO\r\nEND:VCALENDAR\r\n", &me()).is_none());
    assert!(map_resource("http://s/y.ics", "\"1\"", "not a calendar", &me()).is_none());
    // several UIDs in one resource: the first only
    let two = format!("{}{}", ev("u1", "One", ""), ev("u2", "Two", "").replace("BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//t//EN\r\n", "").replace("END:VCALENDAR\r\n", ""));
    let m = map_resource("http://s/two.ics", "\"1\"", &two.replacen("END:VCALENDAR\r\n", "", 1).replace("BEGIN:VEVENT\r\nUID:u2", "BEGIN:VEVENT\r\nUID:u2"), &me()).unwrap();
    assert_eq!(m.uid, "u1");
}

#[test]
fn a_read_only_calendar_and_the_colour_come_through_the_calendar_list() {
    let mut w = world();
    w.colls[0].color = Some("#0A84FFFF".into());
    let mut ro = Coll::new("/calendars/qa1/shared/", "Shared with me");
    ro.writable = false;
    w.colls.push(ro);
    let env = serve(w);
    let (p, _) = setup(&env);
    let cals = p.list_calendars().unwrap();
    let info: Vec<(&str, &str, bool, bool)> = cals.iter().map(|c| (c.name.as_str(), c.color.as_str(), c.read_only, c.primary)).collect();
    assert_eq!(info, vec![("Work", "#0a84ff", false, false), ("Shared with me", "", true, false)], "no calendar is primary: the invitations keep their own entry");
    assert!(cals[0].id.starts_with("http://127.0.0.1:") && cals[0].id.ends_with("/calendars/qa1/work/"));
    assert_eq!(calendar_color("#ABC"), "#aabbcc");
    assert_eq!(calendar_color("red"), "");
    assert_eq!(calendar_color("#12345678"), "#123456");
}

#[test]
fn removing_the_mailbox_or_stopping_the_sync_deletes_everything_of_the_source() {
    let c = conn();
    let src = store::create_dav_source(&c, ACC, 1, &DavSource { url: "http://s/".into(), username: "qa1".into(), preset: Preset::Nextcloud, homes: vec!["http://s/c/".into()], addresses: vec!["qa1@example.test".into()], scheduling: true, trust_cert: true }).unwrap();
    let back = store::get_source(&c, &src.id).unwrap();
    let dav = back.dav.clone().unwrap();
    assert_eq!((dav.preset, dav.scheduling, dav.trust_cert, dav.homes.len(), dav.addresses[0].as_str()), (Preset::Nextcloud, true, true, 1, "qa1@example.test"));
    assert_eq!(dav.label(), "Nextcloud");
    let cal = RemoteCalendar { id: "http://s/c/work/".into(), name: "Work".into(), selected: true, ..Default::default() };
    store::reconcile_calendars(&c, &src, &[cal]).unwrap();
    let row = store::calendars_of(&c, &src.id).unwrap().remove(0);
    let m = map_resource("http://s/c/work/a.ics", "\"1\"", &ev("a", "A", ""), &me()).unwrap();
    let pull = Pull { upserts: m.events, replace: vec!["http://s/c/work/a.ics".into()], resources: vec![RawResource { href: "http://s/c/work/a.ics".into(), etag: "\"1\"".into(), uid: "a".into(), raw: ev("a", "A", "") }], next_state: Some("S:1".into()), full: true, ..Default::default() };
    store::apply_pull(&c, &row, ACC, &pull, Some(0), 10).unwrap();
    assert_eq!(c.query_row::<i64, _, _>("SELECT COUNT(*) FROM cal_resources", [], |r| r.get(0)).unwrap(), 1);
    // stop syncing
    store::disconnect(&c, &src.id).unwrap();
    for t in ["cal_resources", "events", "calendars", "cal_sources", "cal_tombstones"] {
        assert_eq!(c.query_row::<i64, _, _>(&format!("SELECT COUNT(*) FROM {t}"), [], |r| r.get(0)).unwrap(), 0, "{t}");
    }
    // the same for the removal of the mailbox
    let src = store::create_dav_source(&c, ACC, 1, &DavSource { url: "http://s/".into(), username: "qa1".into(), preset: Preset::Other, homes: vec![], addresses: vec![], scheduling: false, trust_cert: false }).unwrap();
    store::reconcile_calendars(&c, &src, &[RemoteCalendar { id: "http://s/c/work/".into(), name: "Work".into(), selected: true, ..Default::default() }]).unwrap();
    let row = store::calendars_of(&c, &src.id).unwrap().remove(0);
    store::apply_pull(&c, &row, ACC, &Pull { resources: vec![RawResource { href: "x".into(), etag: "".into(), uid: "u".into(), raw: "r".into() }], next_state: None, ..Default::default() }, None, 1).unwrap();
    store::forget_account(&c, ACC).unwrap();
    assert_eq!(c.query_row::<i64, _, _>("SELECT COUNT(*) FROM cal_resources", [], |r| r.get(0)).unwrap(), 0);
    assert!(store::source_of_account(&c, ACC).is_none());
}

#[test]
fn presets_know_their_hosts_and_the_imap_hosts_that_suggest_them() {
    assert_eq!(Preset::for_imap_host("imap.mail.me.com"), Preset::Icloud);
    assert_eq!(Preset::for_imap_host("IMAP.fastmail.com"), Preset::Fastmail);
    assert_eq!(Preset::for_imap_host("mail.example.com"), Preset::Other);
    assert_eq!(Preset::Icloud.fixed_url(), Some("https://caldav.icloud.com/"));
    assert_eq!(Preset::Fastmail.fixed_url(), Some("https://caldav.fastmail.com/"));
    assert_eq!(Preset::Nextcloud.fixed_url(), None);
    assert_eq!(Preset::from_str("Nextcloud"), Preset::Nextcloud);
    assert_eq!(Preset::from_str("whatever"), Preset::Other);
    let s = DavSource { url: "https://cloud.example.com/".into(), username: "u".into(), preset: Preset::Other, homes: vec![], addresses: vec![], scheduling: false, trust_cert: false };
    assert_eq!((s.label().as_str(), s.host().as_str()), ("cloud.example.com", "cloud.example.com"));
}

#[test]
fn caldav_is_switched_on_and_offered_with_the_two_oauth_services() {
    assert!(Kind::CalDav.enabled() && Kind::Google.enabled() && Kind::Microsoft.enabled());
    assert_eq!(super::super::cmds::kinds_available(|_| true), ["google", "microsoft", "caldav"]);
    // without the OAuth clients of this build only CalDAV remains (it needs none)
    assert_eq!(super::super::cmds::kinds_available(|_| false), ["caldav"]);
}

// ---------------------------------------------------------------- writing (W7.4 part 2)

const T0: i64 = 1_790_000_000;

fn berlin(y: i32, m: u32, d: u32, h: u32, mi: u32) -> i64 {
    use chrono::TimeZone;
    let tz: chrono_tz::Tz = "Europe/Berlin".parse().unwrap();
    tz.from_local_datetime(&chrono::NaiveDate::from_ymd_opt(y, m, d).unwrap().and_hms_opt(h, mi, 0).unwrap()).earliest().unwrap().timestamp()
}

fn utc_ts(y: i32, m: u32, d: u32, h: u32, mi: u32) -> i64 {
    chrono::NaiveDate::from_ymd_opt(y, m, d).unwrap().and_hms_opt(h, mi, 0).unwrap().and_utc().timestamp()
}

fn server_raw(env: &Env, name: &str) -> String {
    env.w.lock().unwrap().colls[0].res.get(name).map(|(_, r)| r.clone()).unwrap_or_default()
}

fn server_etag(env: &Env, name: &str) -> String {
    env.w.lock().unwrap().colls[0].res.get(name).map(|(e, _)| e.clone()).unwrap_or_default()
}

fn flat(s: &str) -> String {
    s.replace("\r\n ", "")
}

/// What another client wrote: lines the app does not manage.
const RICH: &str = "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Other//EN\r\nBEGIN:VEVENT\r\nUID:rich@other\r\nDTSTAMP:20261001T080000Z\r\nDTSTART:20261020T090000Z\r\nDTEND:20261020T100000Z\r\nSEQUENCE:3\r\nSUMMARY:Dentist\r\nX-HL-TEST:keep\r\nATTACH;FMTTYPE=application/pdf:https://example.org/a.pdf\r\nBEGIN:VALARM\r\nACTION:AUDIO\r\nTRIGGER:-PT5M\r\nEND:VALARM\r\nBEGIN:VALARM\r\nACTION:DISPLAY\r\nDESCRIPTION:Reminder\r\nTRIGGER:-PT15M\r\nEND:VALARM\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n";

#[test]
fn a_new_event_is_put_with_if_none_match_and_an_edit_keeps_what_the_other_client_wrote() {
    let env = serve(world());
    let (p, cal) = setup(&env);
    let draft = EventDraft { summary: "Lunch".into(), start: berlin(2026, 10, 20, 12, 0), end: berlin(2026, 10, 20, 13, 0), tzid: Some("Europe/Berlin".into()), reminder_min: Some(15), ..Default::default() };
    let made = p.create(&cal, &draft).unwrap();
    assert!(made.id.ends_with(".ics") && made.etag.starts_with("\"e") && made.uid.ends_with("@heylook"), "{made:?}");
    let name = made.id.rsplit('/').next().unwrap().to_string();
    assert_eq!(env.w.lock().unwrap().conds[0], ("PUT".into(), String::new(), "*".into()), "a new resource is created, never overwritten");
    let raw = server_raw(&env, &name);
    assert!(raw.contains("DTSTART;TZID=Europe/Berlin:20261020T120000\r\n") && raw.contains("BEGIN:VTIMEZONE\r\nTZID:Europe/Berlin\r\n") && raw.contains("TRIGGER:-PT15M"), "{raw}");
    // the app reads back what it wrote
    assert_eq!((made.summary.as_str(), made.start, made.reminder_min, made.kind), ("Lunch", draft.start, Some(15), EventKind::Single));

    // another client's resource with lines the app does not know
    {
        let mut g = env.w.lock().unwrap();
        put(&mut g, 0, "rich.ics", RICH.to_string());
    }
    let id = format!("{}/calendars/qa1/work/rich.ics", env.srv.base);
    let etag = server_etag(&env, "rich.ics");
    let patch = EventPatch {
        summary: Some("Dentist (moved)".into()),
        when: Some(super::super::When { start: utc_ts(2026, 10, 20, 12, 0), end: utc_ts(2026, 10, 20, 13, 0), all_day: false, tzid: None }),
        location: Some(Some("Clinic".into())),
        ..Default::default()
    };
    // a stale etag is a conflict, nothing is sent
    let before = env.w.lock().unwrap().conds.len();
    assert_eq!(p.update(&cal, &id, "\"stale\"", &patch).unwrap_err(), SyncErr::Conflict);
    assert_eq!(env.w.lock().unwrap().conds.len(), before, "no PUT with a stale version");
    let got = p.update(&cal, &id, &etag, &patch).unwrap();
    assert_eq!((got.summary.as_str(), got.start, got.location.as_deref()), ("Dentist (moved)", utc_ts(2026, 10, 20, 12, 0), Some("Clinic")));
    assert_ne!(got.etag, etag);
    let raw = server_raw(&env, "rich.ics");
    for keep in ["X-HL-TEST:keep\r\n", "ATTACH;FMTTYPE=application/pdf:https://example.org/a.pdf\r\n", "ACTION:AUDIO\r\nTRIGGER:-PT5M\r\n", "ACTION:DISPLAY\r\nDESCRIPTION:Reminder\r\nTRIGGER:-PT15M\r\n", "PRODID:-//Other//EN\r\n"] {
        assert!(raw.contains(keep), "lost {keep}: {raw}");
    }
    assert!(raw.contains("SEQUENCE:4\r\n") && raw.contains("DTSTART:20261020T120000Z\r\n") && raw.contains("LOCATION:Clinic\r\n"), "the time changed: the sequence grew: {raw}");
    assert_eq!(env.w.lock().unwrap().conds.last().unwrap(), &("PUT".to_string(), etag.clone(), String::new()), "the edit carries the version it started from");
    // a delete with the old version is a conflict, with the new one it works, a second one finds nothing
    assert_eq!(p.delete(&cal, &id, &etag).unwrap_err(), SyncErr::Conflict);
    p.delete(&cal, &id, &got.etag).unwrap();
    assert!(server_raw(&env, "rich.ics").is_empty());
    assert_eq!(p.delete(&cal, &id, &got.etag).unwrap_err(), SyncErr::NotFound);
    assert_eq!(p.update(&cal, &id, &got.etag, &patch).unwrap_err(), SyncErr::NotFound);
}

#[test]
fn the_answers_of_a_server_that_refuses_a_write_are_sorted() {
    let draft = EventDraft { summary: "x".into(), start: T0, end: T0 + 3600, ..Default::default() };
    // the name is taken once: the event is put again under another name
    let mut w = world();
    w.first_put_412 = true;
    let env = serve(w);
    let (p, cal) = setup(&env);
    let made = p.create(&cal, &draft).unwrap();
    assert_eq!(env.w.lock().unwrap().conds.iter().filter(|c| c.2 == "*").count(), 2, "a second try with another name");
    assert!(made.id.ends_with(".ics"));
    // no ETag in the answer: the version is asked for
    let mut w = world();
    w.put_no_etag = true;
    let env = serve(w);
    let (p, cal) = setup(&env);
    let made = p.create(&cal, &draft).unwrap();
    let name = made.id.rsplit('/').next().unwrap();
    assert_eq!(made.etag, server_etag(&env, name));
    // no right to write
    let mut w = world();
    w.deny_writes = true;
    let env = serve(w);
    let (p, cal) = setup(&env);
    assert_eq!(p.create(&cal, &draft).unwrap_err(), SyncErr::ReadOnly);
    assert_eq!(p.delete(&cal, &format!("{}/calendars/qa1/work/a.ics", env.srv.base), "").unwrap_err(), SyncErr::ReadOnly);
    // other refusals say why in a few words
    let mut w = world();
    w.put_error = Some((403, r#"<D:error xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav"><C:valid-calendar-data/></D:error>"#));
    let env = serve(w);
    let (p, cal) = setup(&env);
    assert_eq!(p.create(&cal, &draft).unwrap_err(), SyncErr::Other("the server didn’t accept the event data".into()));
    let mut w = world();
    w.put_error = Some((507, ""));
    let env = serve(w);
    let (p, cal) = setup(&env);
    assert!(matches!(p.create(&cal, &draft).unwrap_err(), SyncErr::Other(t) if t.contains("full")));
    // a server that is not there: offline, nothing written
    let port = { std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port() };
    let gone = CalDavProvider::new(
        DavSource { url: format!("http://127.0.0.1:{port}/"), username: USER.into(), preset: Preset::Other, homes: vec![], addresses: vec![], scheduling: false, trust_cert: false },
        PASS,
        "qa1@example.test",
    );
    let c = RemoteCalendar { id: format!("http://127.0.0.1:{port}/calendars/qa1/work/"), ..Default::default() };
    assert_eq!(gone.create(&c, &draft).unwrap_err(), SyncErr::Offline);
    // the texts the person reads
    use super::super::write::error_text;
    assert_eq!(error_text(&SyncErr::ReadOnly, "Nextcloud", "Work", "me@x.y"), "CAL_READ_ONLY: Work is read only.");
    assert_eq!(error_text(&SyncErr::Conflict, "Nextcloud", "Work", "me@x.y"), "CAL_CONFLICT: This event was changed in Nextcloud, so its latest version is shown.");
}

#[test]
fn an_answer_to_an_invitation_changes_only_my_partstat() {
    let invite = "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:inv@other\r\nDTSTART:20261020T090000Z\r\nDTEND:20261020T100000Z\r\nSUMMARY:Meeting\r\nORGANIZER;CN=Mai:mailto:mai@x.y\r\nATTENDEE;CN=Mai;PARTSTAT=ACCEPTED:mailto:mai@x.y\r\nATTENDEE;PARTSTAT=NEEDS-ACTION;RSVP=TRUE;X-NUM-GUESTS=1:mailto:QA1@example.test\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n";
    let mut w = world();
    put(&mut w, 0, "inv.ics", invite.to_string());
    let env = serve(w);
    let (p, cal) = setup(&env);
    let id = format!("{}/calendars/qa1/work/inv.ics", env.srv.base);
    p.respond(&cal, &id, &server_etag(&env, "inv.ics"), Rsvp::Accepted, "qa1@example.test", &[]).unwrap();
    let raw = flat(&server_raw(&env, "inv.ics"));
    assert!(raw.contains("ATTENDEE;PARTSTAT=ACCEPTED;RSVP=TRUE;X-NUM-GUESTS=1:mailto:QA1@example.test\r\n"), "{raw}");
    assert!(raw.contains("ATTENDEE;CN=Mai;PARTSTAT=ACCEPTED:mailto:mai@x.y\r\n") && !raw.contains("SEQUENCE"));
    // the same answer again is not written
    let n = env.w.lock().unwrap().conds.len();
    p.respond(&cal, &id, &server_etag(&env, "inv.ics"), Rsvp::Accepted, "qa1@example.test", &[]).unwrap();
    assert_eq!(env.w.lock().unwrap().conds.len(), n);
}

struct Fac(DavSource);

impl ProviderFactory for Fac {
    fn provider(&self, _: &store::Source) -> Result<Box<dyn CalProvider>, SyncErr> {
        Ok(Box::new(CalDavProvider::new(self.0.clone(), PASS, "me@gmail.test")))
    }
}

struct Setup {
    env: Env,
    db: crate::Db,
    fac: Fac,
    cal: String,
}

const WEEKLY: &str = "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Other//EN\r\nBEGIN:VTIMEZONE\r\nTZID:Europe/Berlin\r\nBEGIN:STANDARD\r\nDTSTART:19701025T030000\r\nTZOFFSETFROM:+0200\r\nTZOFFSETTO:+0100\r\nRRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU\r\nEND:STANDARD\r\nBEGIN:DAYLIGHT\r\nDTSTART:19700329T020000\r\nTZOFFSETFROM:+0100\r\nTZOFFSETTO:+0200\r\nRRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU\r\nEND:DAYLIGHT\r\nEND:VTIMEZONE\r\nBEGIN:VEVENT\r\nUID:weekly@other\r\nDTSTAMP:20261001T080000Z\r\nDTSTART;TZID=Europe/Berlin:20261013T090000\r\nDTEND;TZID=Europe/Berlin:20261013T100000\r\nRRULE:FREQ=WEEKLY;BYDAY=TU;COUNT=8\r\nSUMMARY:Weekly sync\r\nX-HL-TEST:keep\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n";

fn engine_setup(w: World) -> Setup {
    let env = serve(w);
    let d = discover(&http(&env, Preset::Other), &env.srv.base, Preset::Other).unwrap();
    let dav = dav_source(&env, &d);
    let c = conn();
    let src = store::create_dav_source(&c, ACC, 0, &dav).unwrap();
    let db: crate::Db = Arc::new(Mutex::new(c));
    let fac = Fac(dav);
    engine::sync_source(&db, &fac, &src.id, Clock { now: T0, jitter: 0.5 }, &|| {}).unwrap();
    let cal = store::calendars_of(&lock(&db), &src.id).unwrap().remove(0).id;
    Setup { env, db, fac, cal }
}

impl Setup {
    fn row(&self, name: &str) -> String {
        let remote = format!("{}/calendars/qa1/work/{name}", self.env.srv.base);
        lock(&self.db).query_row("SELECT id FROM events WHERE remote_id=?1", [&remote], |r| r.get(0)).unwrap_or_else(|_| panic!("no row for {remote}"))
    }

    fn row_of_slot(&self, slot: i64) -> Option<String> {
        lock(&self.db).query_row("SELECT id FROM events WHERE calendar_id=?1 AND recurrence_id=?2", rusqlite::params![self.cal, slot.to_string()], |r| r.get(0)).ok()
    }

    fn pull(&self, at: i64) {
        engine::refresh_calendar(&self.db, &self.fac, &self.cal, Clock { now: at, jitter: 0.5 }).unwrap();
    }

    fn shown(&self) -> Vec<String> {
        use chrono::TimeZone;
        let tz: chrono_tz::Tz = "Europe/Berlin".parse().unwrap();
        crate::calendar::list_range(&lock(&self.db), berlin(2026, 10, 1, 0, 0), berlin(2027, 1, 1, 0, 0))
            .unwrap()
            .into_iter()
            .map(|x| format!("{} {}", x.summary, tz.timestamp_opt(x.start, 0).unwrap().format("%d.%m %H:%M")))
            .collect()
    }

    fn input(&self, id: &str, title: &str, start: i64, rrule: Option<&str>, scope: &str, slot: Option<i64>) -> crate::calendar::CalEventInput {
        crate::calendar::CalEventInput {
            id: Some(id.into()),
            account_id: None,
            summary: title.into(),
            start,
            end: start + 3600,
            all_day: false,
            tzid: Some("Europe/Berlin".into()),
            location: None,
            description: None,
            attendees: vec![],
            rrule: rrule.map(String::from),
            reminder_min: None,
            calendar_id: Some(self.cal.clone()),
            scope: Some(scope.into()),
            occurrence_start: slot,
        }
    }

    fn names(&self) -> Vec<String> {
        self.env.w.lock().unwrap().colls[0].res.keys().cloned().collect()
    }
}

#[test]
fn the_scopes_of_a_series_write_overrides_exdates_and_a_cut_into_the_resource() {
    use super::super::write;
    let mut w = world();
    put(&mut w, 0, "weekly.ics", WEEKLY.to_string());
    let s = engine_setup(w);
    let master = s.row("weekly.ics");
    assert_eq!(s.shown().len(), 8);
    let rule = "FREQ=WEEKLY;BYDAY=TU;COUNT=8";

    // this occurrence: an override in the same resource, the master untouched
    let slot = berlin(2026, 10, 27, 9, 0);
    let got = write::save(&s.db, &s.fac, &s.input(&master, "Weekly sync", berlin(2026, 10, 27, 11, 0), None, "occurrence", Some(slot))).unwrap();
    assert_eq!((got.remote_kind.as_deref(), got.start), (Some("exception"), berlin(2026, 10, 27, 11, 0)));
    let raw = flat(&server_raw(&s.env, "weekly.ics"));
    assert!(raw.contains("RECURRENCE-ID;TZID=Europe/Berlin:20261027T090000\r\n") && raw.contains("DTSTART;TZID=Europe/Berlin:20261027T110000\r\n"), "{raw}");
    assert!(raw.contains("RRULE:FREQ=WEEKLY;BYDAY=TU;COUNT=8\r\nSUMMARY:Weekly sync\r\nX-HL-TEST:keep\r\n"), "the master is as it was: {raw}");
    assert_eq!(s.names(), vec!["weekly.ics".to_string()]);
    let list = s.shown();
    assert_eq!(list.len(), 8, "{list:?}");
    assert!(list.contains(&"Weekly sync 27.10 11:00".to_string()) && !list.contains(&"Weekly sync 27.10 09:00".to_string()));
    s.pull(T0 + 60);
    assert_eq!(s.shown(), list, "the next sync brings nothing new");

    // the same occurrence again goes to its override
    let exc = s.row_of_slot(slot).expect("the override is a row");
    write::save(&s.db, &s.fac, &s.input(&exc, "Weekly sync", berlin(2026, 10, 27, 12, 0), None, "occurrence", None)).unwrap();
    assert!(s.shown().contains(&"Weekly sync 27.10 12:00".to_string()));
    assert_eq!(flat(&server_raw(&s.env, "weekly.ics")).matches("RECURRENCE-ID").count(), 1, "one override");

    // delete another occurrence: an EXDATE
    let gone = berlin(2026, 11, 3, 9, 0);
    write::delete(&s.db, &s.fac, &master, Some(crate::calseries::Scope::Occurrence), Some(gone)).unwrap();
    assert!(flat(&server_raw(&s.env, "weekly.ics")).contains("EXDATE;TZID=Europe/Berlin:20261103T090000\r\n"));
    assert_eq!(s.shown().len(), 7);
    s.pull(T0 + 120);
    assert_eq!(s.shown().len(), 7, "after the sync the slot stays empty");

    // delete the changed occurrence: its override goes and the slot is excluded
    let exc = s.row_of_slot(slot).unwrap();
    write::delete(&s.db, &s.fac, &exc, Some(crate::calseries::Scope::Occurrence), None).unwrap();
    let raw = flat(&server_raw(&s.env, "weekly.ics"));
    assert!(!raw.contains("RECURRENCE-ID") && raw.contains("EXDATE;TZID=Europe/Berlin:20261027T090000\r\n"), "{raw}");
    s.pull(T0 + 180);
    assert_eq!(s.shown().len(), 6);

    // this and following from 17 Nov: the old part ends before it, a new resource starts at it with the new title
    let from = berlin(2026, 11, 17, 9, 0);
    write::save(&s.db, &s.fac, &s.input(&master, "Weekly sync (new)", from, Some(rule), "following", Some(from))).unwrap();
    s.pull(T0 + 240);
    let names = s.names();
    assert_eq!(names.len(), 2, "{names:?}");
    let old = flat(&server_raw(&s.env, "weekly.ics"));
    assert!(old.contains("RRULE:FREQ=WEEKLY;BYDAY=TU;COUNT=5\r\n"), "the old part is cut: {old}");
    assert!(old.contains("X-HL-TEST:keep"));
    let new_name = names.iter().find(|n| *n != "weekly.ics").unwrap().clone();
    let new = flat(&server_raw(&s.env, &new_name));
    assert!(new.contains("SUMMARY:Weekly sync (new)\r\n") && new.contains("DTSTART;TZID=Europe/Berlin:20261117T090000\r\n") && new.contains("RRULE:FREQ=WEEKLY;BYDAY=TU;COUNT=3\r\n"), "{new}");
    assert!(!new.contains("UID:weekly@other"), "a new series has its own UID");
    let list = s.shown();
    assert_eq!(list.iter().filter(|x| x.starts_with("Weekly sync (new)")).count(), 3, "{list:?}");
    assert_eq!(list.len(), 6, "no date twice: {list:?}");

    // the whole (old) series: a title change is one PUT of the master
    let n = s.env.w.lock().unwrap().conds.len();
    write::save(&s.db, &s.fac, &s.input(&master, "Renamed", berlin(2026, 10, 13, 9, 0), Some("FREQ=WEEKLY;BYDAY=TU;COUNT=5"), "series", None)).unwrap();
    assert_eq!(s.env.w.lock().unwrap().conds.len(), n + 1);
    assert!(flat(&server_raw(&s.env, "weekly.ics")).contains("SUMMARY:Renamed\r\n"));

    // delete the series: the resource is deleted with the version the app has
    write::delete(&s.db, &s.fac, &master, Some(crate::calseries::Scope::Series), None).unwrap();
    assert!(server_raw(&s.env, "weekly.ics").is_empty());
    s.pull(T0 + 300);
    assert!(s.shown().iter().all(|x| x.starts_with("Weekly sync (new)")));
}

#[test]
fn a_conflict_shows_the_servers_version_and_a_single_event_is_created_edited_and_deleted_through_the_engine() {
    use super::super::write;
    let mut w = world();
    put(&mut w, 0, "rich.ics", RICH.to_string());
    let s = engine_setup(w);
    let id = s.row("rich.ics");
    // create
    let mut inp = s.input("", "Lunch", berlin(2026, 10, 22, 12, 0), None, "", None);
    inp.id = None;
    inp.scope = None;
    let made = write::save(&s.db, &s.fac, &inp).unwrap();
    assert_eq!((made.summary.as_str(), made.start, made.remote_kind.as_deref()), ("Lunch", berlin(2026, 10, 22, 12, 0), Some("single")));
    assert_eq!(s.names().len(), 2);
    // the other client changes the resource after the app synced; the app's edit is a conflict and the server's text wins
    {
        let mut g = s.env.w.lock().unwrap();
        put(&mut g, 0, "rich.ics", RICH.replace("SUMMARY:Dentist", "SUMMARY:Dentist (changed elsewhere)"));
    }
    let mut edit = s.input(&id, "Dentist (mine)", utc_ts(2026, 10, 20, 9, 0), None, "", None);
    edit.tzid = None;
    edit.scope = None;
    let e = write::save(&s.db, &s.fac, &edit).unwrap_err();
    assert!(e.starts_with("CAL_CONFLICT:"), "{e}");
    assert!(s.shown().iter().any(|x| x.starts_with("Dentist (changed elsewhere)")), "{:?}", s.shown());
    assert!(server_raw(&s.env, "rich.ics").contains("(changed elsewhere)"), "the server's version was not overwritten");
    // a delete with a stale version is a conflict too
    {
        let mut g = s.env.w.lock().unwrap();
        put(&mut g, 0, "rich.ics", RICH.replace("SUMMARY:Dentist", "SUMMARY:Dentist again"));
    }
    let e = write::delete(&s.db, &s.fac, &id, None, None).unwrap_err();
    assert!(e.starts_with("CAL_CONFLICT:"), "{e}");
    assert!(!server_raw(&s.env, "rich.ics").is_empty());
    // now the version is the server's: the delete works
    write::delete(&s.db, &s.fac, &s.row("rich.ics"), None, None).unwrap();
    assert!(server_raw(&s.env, "rich.ics").is_empty());
    // a read-only calendar is refused before anything is sent
    let mut w = world();
    w.colls[0].writable = false;
    put(&mut w, 0, "ro.ics", RICH.to_string());
    let s = engine_setup(w);
    let n = s.env.w.lock().unwrap().conds.len();
    let e = write::delete(&s.db, &s.fac, &s.row("ro.ics"), None, None).unwrap_err();
    assert!(e.starts_with("CAL_READ_ONLY:"), "{e}");
    assert_eq!(s.env.w.lock().unwrap().conds.len(), n);
}

#[test]
fn the_app_sends_the_invitations_only_where_the_server_does_not() {
    let c = conn();
    let mk = |sched: bool| {
        let dav = DavSource { url: "http://s/".into(), username: "qa1".into(), preset: Preset::Other, homes: vec![], addresses: vec![], scheduling: sched, trust_cert: false };
        let src = store::create_dav_source(&c, ACC, 1, &dav).unwrap();
        store::reconcile_calendars(&c, &src, &[RemoteCalendar { id: "http://s/c/work/".into(), name: "Work".into(), selected: true, ..Default::default() }]).unwrap();
        let id = store::calendars_of(&c, &src.id).unwrap().remove(0).id;
        (src, id)
    };
    let (src, cal) = mk(false);
    let acc = crate::calendar::app_inviter(&c, &cal).expect("a server without scheduling: this app sends");
    assert_eq!(acc.email, "me@gmail.test");
    let info = crate::calendar::list_calendars(&c).unwrap().into_iter().find(|x| x.id == cal).unwrap();
    assert!(info.app_invites, "{info:?}");
    assert_eq!(info.service.as_deref(), Some("s"), "the service is named by its host");
    // the invitation: this mailbox as organizer and chair first, the guests with their answers
    let calrow = store::get_calendar(&c, &cal).unwrap();
    let mut re = RemoteEvent::single("http://s/c/work/a.ics", "A", T0, T0 + 3600);
    re.attendees = vec![crate::calendar::CalAttendee { email: "G@x.test".into(), name: None, role: "required".into(), status: "accepted".into(), is_you: false }];
    let e = store::upsert_remote(&c, &calrow, ACC, &re).unwrap();
    let m = crate::calendar::invitation_of(&acc, &e);
    assert_eq!((m.attendees[0].role.as_str(), m.attendees[0].email.as_str(), m.attendees[1].email.as_str(), m.attendees[1].status.as_str()), ("chair", "me@gmail.test", "g@x.test", "accepted"));
    assert_eq!((m.organizer.as_ref().map(|o| o.email.as_str()), m.my_status.as_deref()), (Some("me@gmail.test"), Some("organizer")));
    // a server that schedules itself: nothing is sent by the app, and the calendar says so
    store::disconnect(&c, &src.id).unwrap();
    let (_, cal2) = mk(true);
    assert!(crate::calendar::app_inviter(&c, &cal2).is_none());
    assert!(!crate::calendar::list_calendars(&c).unwrap().into_iter().find(|x| x.id == cal2).unwrap().app_invites);
}

#[test]
fn a_resource_moves_to_another_calendar_and_a_calendar_is_made_with_mkcalendar() {
    let mut w = world();
    w.colls.push(Coll::new("/calendars/qa1/family2/", "Family"));
    put(&mut w, 0, "rich.ics", RICH.to_string());
    let env = serve(w);
    let (p, cal) = setup(&env);
    let cals = p.list_calendars().unwrap();
    let target = cals.iter().find(|c| c.name == "Family").unwrap().clone();
    let id = format!("{}/calendars/qa1/work/rich.ics", env.srv.base);
    let etag = server_etag(&env, "rich.ics");
    // a stale version is a conflict and nothing moves
    assert_eq!(p.move_event(&cal, &id, "\"stale\"", &target).unwrap_err(), SyncErr::Conflict);
    assert!(!server_raw(&env, "rich.ics").is_empty() && env.w.lock().unwrap().colls[1].res.is_empty());
    let moved = p.move_event(&cal, &id, &etag, &target).unwrap();
    assert!(moved.id.ends_with("/calendars/qa1/family2/rich.ics") && moved.uid == "rich@other", "{moved:?}");
    assert!(server_raw(&env, "rich.ics").is_empty(), "gone from the source");
    let g = env.w.lock().unwrap();
    let there = &g.colls[1].res["rich.ics"].1;
    assert_eq!(there, RICH, "the same text, line for line");
    // the order: PUT with If-None-Match in the target, then DELETE with the version of the original
    let conds: Vec<_> = g.conds.iter().filter(|c| c.0 != "MKCALENDAR").collect();
    assert_eq!(conds[0], &("PUT".to_string(), String::new(), "*".to_string()));
    assert_eq!((conds[1].0.as_str(), conds[1].1.as_str()), ("DELETE", etag.as_str()));
    drop(g);
    // the name is taken in the target: the same text under another name, once
    {
        let mut g = env.w.lock().unwrap();
        put(&mut g, 0, "rich.ics", RICH.to_string());
        put(&mut g, 1, "rich.ics", "BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n".to_string());
    }
    let moved = p.move_event(&cal, &id, &server_etag(&env, "rich.ics"), &target).unwrap();
    assert!(!moved.id.ends_with("/rich.ics") && moved.id.ends_with(".ics"), "{moved:?}");
    assert_eq!(env.w.lock().unwrap().colls[1].res.len(), 2);
    // a new calendar: MKCALENDAR in the home with the name, then it is in the list
    let made = p.create_calendar("Hobbies & <fun>").unwrap();
    assert!(made.id.starts_with(&format!("{}/calendars/qa1/", env.srv.base)) && made.id.ends_with('/') && !made.read_only, "{made:?}");
    assert!(env.w.lock().unwrap().conds.iter().any(|c| c.0 == "MKCALENDAR"));
    assert!(p.list_calendars().unwrap().iter().any(|c| c.id == made.id && c.name == "Hobbies &amp; &lt;fun&gt;" || c.id == made.id), "the server lists it");
    // a server that refuses
    let mut w = world();
    w.deny_writes = true;
    let env = serve(w);
    let (p, _) = setup(&env);
    assert!(p.create_calendar("x").is_err());
}
