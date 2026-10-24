//! The XML of CalDAV (WebDAV RFC 4918, CalDAV RFC 4791, collection sync RFC 6578): the bodies of the requests the client sends and the reading of a multistatus answer.
//! Names are matched by namespace and local name, never by prefix (servers choose their own prefixes).
use roxmltree::{Document, Node};
use std::collections::HashMap;

const DAV: &str = "DAV:";
const CALDAV: &str = "urn:ietf:params:xml:ns:caldav";
const CS: &str = "http://calendarserver.org/ns/";
const APPLE: &str = "http://apple.com/ns/ical/";

/// One property of a response: its text, the hrefs inside it and the names of the elements inside it.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct PropVal {
    /// the text of the property, trimmed
    pub text: String,
    /// `D:href` values anywhere inside (a principal, a calendar home, the user's calendar addresses)
    pub hrefs: Vec<String>,
    /// local names of every element inside (resourcetype, the privileges, the reports a collection supports)
    pub tags: Vec<String>,
    /// `name` attributes of `C:comp` elements (the components a calendar holds)
    pub comps: Vec<String>,
}

/// One `D:response`: a resource and its properties.
#[derive(Debug, Clone, Default)]
pub struct DavResponse {
    pub href: String,
    /// the status of the response as a whole (sync-collection answers 404 here for a resource that was removed)
    pub status: Option<u16>,
    /// the properties that came with a 2xx status, by key (`D:getetag`, `C:calendar-data`, `CS:getctag`, `A:calendar-color`; another namespace as `{ns}local`)
    pub props: HashMap<String, PropVal>,
    /// the keys of the properties the server said it does not have (a 404 propstat)
    pub missing: Vec<String>,
}

impl DavResponse {
    pub fn text(&self, key: &str) -> Option<&str> {
        self.props.get(key).map(|p| p.text.as_str()).filter(|t| !t.is_empty())
    }
    pub fn has_tag(&self, key: &str, tag: &str) -> bool {
        self.props.get(key).is_some_and(|p| p.tags.iter().any(|t| t == tag))
    }
}

#[derive(Debug, Clone, Default)]
pub struct Multistatus {
    pub responses: Vec<DavResponse>,
    pub sync_token: Option<String>,
}

fn key(n: Node) -> String {
    let t = n.tag_name();
    let local = t.name();
    match t.namespace() {
        Some(DAV) => format!("D:{local}"),
        Some(CALDAV) => format!("C:{local}"),
        Some(CS) => format!("CS:{local}"),
        Some(APPLE) => format!("A:{local}"),
        Some(ns) => format!("{{{ns}}}{local}"),
        None => local.to_string(),
    }
}

fn is(n: Node, ns: &str, local: &str) -> bool {
    n.is_element() && n.tag_name().namespace() == Some(ns) && n.tag_name().name() == local
}

fn text_of(n: Node) -> String {
    n.descendants().filter(|d| d.is_text()).filter_map(|d| d.text()).collect::<String>().trim().to_string()
}

fn status_code(s: &str) -> Option<u16> {
    s.split_whitespace().nth(1)?.parse().ok()
}

fn prop_val(p: Node) -> PropVal {
    let mut v = PropVal { text: text_of(p), ..Default::default() };
    for d in p.descendants().filter(|d| d.is_element() && *d != p) {
        v.tags.push(d.tag_name().name().to_string());
        if is(d, DAV, "href") {
            let h = text_of(d);
            if !h.is_empty() {
                v.hrefs.push(h);
            }
        }
        if is(d, CALDAV, "comp") {
            if let Some(n) = d.attribute("name") {
                v.comps.push(n.to_ascii_uppercase());
            }
        }
    }
    v
}

/// Read a `D:multistatus`. `Err` when the text is not XML or its root is something else (a server that answers a PROPFIND with an HTML page is not a CalDAV server).
pub fn parse_multistatus(xml: &str) -> Result<Multistatus, String> {
    let doc = Document::parse(xml).map_err(|e| format!("not XML: {e}"))?;
    let root = doc.root_element();
    if !is(root, DAV, "multistatus") {
        return Err(format!("not a multistatus (the document is a {})", root.tag_name().name()));
    }
    let mut out = Multistatus::default();
    for c in root.children().filter(|c| c.is_element()) {
        if is(c, DAV, "sync-token") {
            out.sync_token = Some(text_of(c)).filter(|t| !t.is_empty());
        } else if is(c, DAV, "response") {
            let mut r = DavResponse::default();
            for part in c.children().filter(|x| x.is_element()) {
                if is(part, DAV, "href") && r.href.is_empty() {
                    r.href = text_of(part);
                } else if is(part, DAV, "status") {
                    r.status = status_code(&text_of(part));
                } else if is(part, DAV, "propstat") {
                    let st = part.children().find(|x| is(*x, DAV, "status")).map(text_of).and_then(|s| status_code(&s)).unwrap_or(200);
                    for prop in part.children().filter(|x| is(*x, DAV, "prop")) {
                        for p in prop.children().filter(|x| x.is_element()) {
                            if (200..300).contains(&st) {
                                r.props.insert(key(p), prop_val(p));
                            } else {
                                r.missing.push(key(p));
                            }
                        }
                    }
                }
            }
            out.responses.push(r);
        }
        // (a `D:sync-token` inside a response is not the collection's)
    }
    Ok(out)
}

/// The names of the elements inside a `D:error` body (`valid-sync-token`, `need-privileges`, `valid-calendar-data`, ...), lower case; empty when the text is not such a body.
pub fn error_tags(xml: &str) -> Vec<String> {
    let Ok(doc) = Document::parse(xml) else { return vec![] };
    let root = doc.root_element();
    if !is(root, DAV, "error") {
        return vec![];
    }
    root.descendants().filter(|d| d.is_element() && *d != root).map(|d| d.tag_name().name().to_ascii_lowercase()).collect()
}

// ------------------------------------------------------------------ requests

fn esc(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;")
}

const HEAD: &str = r#"<?xml version="1.0" encoding="utf-8"?>"#;
const NS: &str = r#"xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav" xmlns:CS="http://calendarserver.org/ns/" xmlns:A="http://apple.com/ns/ical/""#;

/// A PROPFIND for the given properties (`D:displayname`, `C:calendar-home-set`, ... written with the prefixes this module uses).
pub fn propfind(props: &[&str]) -> String {
    let list: String = props.iter().map(|p| format!("<{p}/>")).collect();
    format!("{HEAD}<D:propfind {NS}><D:prop>{list}</D:prop></D:propfind>")
}

/// Who the user is on the server.
pub fn propfind_principal() -> String {
    propfind(&["D:current-user-principal", "D:resourcetype"])
}

/// The calendar home and the addresses of the user, asked of the principal.
pub fn propfind_home() -> String {
    propfind(&["C:calendar-home-set", "C:calendar-user-address-set", "D:displayname"])
}

/// What a calendar collection is (Depth 1 on the home).
pub fn propfind_collections() -> String {
    propfind(&[
        "D:resourcetype",
        "D:displayname",
        "A:calendar-color",
        "D:current-user-privilege-set",
        "CS:getctag",
        "D:sync-token",
        "D:supported-report-set",
        "C:supported-calendar-component-set",
        "C:calendar-timezone",
    ])
}

/// The version of a collection: its ctag and sync token (Depth 0).
pub fn propfind_state() -> String {
    propfind(&["CS:getctag", "D:sync-token"])
}

/// The etag of every resource in a collection (Depth 1), for a server without sync tokens.
pub fn propfind_etags() -> String {
    propfind(&["D:getetag", "D:resourcetype"])
}

/// An RFC 6578 sync-collection report. An empty token asks for everything.
pub fn sync_collection(token: &str) -> String {
    let tok = if token.is_empty() { "<D:sync-token/>".to_string() } else { format!("<D:sync-token>{}</D:sync-token>", esc(token)) };
    format!("{HEAD}<D:sync-collection {NS}>{tok}<D:sync-level>1</D:sync-level><D:prop><D:getetag/></D:prop></D:sync-collection>")
}

/// A calendar-multiget for these resources (their etag and the iCalendar text).
pub fn multiget(hrefs: &[String]) -> String {
    let list: String = hrefs.iter().map(|h| format!("<D:href>{}</D:href>", esc(h))).collect();
    format!("{HEAD}<C:calendar-multiget {NS}><D:prop><D:getetag/><C:calendar-data/></D:prop>{list}</C:calendar-multiget>")
}

/// A calendar-query for every VEVENT of a collection, answered with etag and data (the fallback of a server that does not answer a multiget).
pub fn query_events() -> String {
    format!(
        r#"{HEAD}<C:calendar-query {NS}><D:prop><D:getetag/><C:calendar-data/></D:prop><C:filter><C:comp-filter name="VCALENDAR"><C:comp-filter name="VEVENT"/></C:comp-filter></C:filter></C:calendar-query>"#
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_multistatus_is_read_by_namespace_not_prefix() {
        // Radicale-like prefixes and a response with a missing property
        let xml = r#"<?xml version="1.0"?>
<multistatus xmlns="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav" xmlns:ICAL="http://apple.com/ns/ical/" xmlns:CS="http://calendarserver.org/ns/">
 <response><href>/qa1/cal1/</href>
  <propstat><prop>
    <resourcetype><collection/><C:calendar/></resourcetype>
    <displayname>Work</displayname>
    <ICAL:calendar-color>#FF8800FF</ICAL:calendar-color>
    <current-user-privilege-set><privilege><read/></privilege><privilege><write-content/></privilege></current-user-privilege-set>
    <CS:getctag>ctag-7</CS:getctag>
    <supported-report-set><supported-report><report><sync-collection/></report></supported-report></supported-report-set>
    <C:supported-calendar-component-set><C:comp name="VEVENT"/><C:comp name="vtodo"/></C:supported-calendar-component-set>
  </prop><status>HTTP/1.1 200 OK</status></propstat>
  <propstat><prop><sync-token/></prop><status>HTTP/1.1 404 Not Found</status></propstat>
 </response>
 <sync-token>http://x/sync/42</sync-token>
</multistatus>"#;
        let m = parse_multistatus(xml).unwrap();
        assert_eq!(m.sync_token.as_deref(), Some("http://x/sync/42"));
        let r = &m.responses[0];
        assert_eq!(r.href, "/qa1/cal1/");
        assert!(r.has_tag("D:resourcetype", "calendar") && r.has_tag("D:resourcetype", "collection"));
        assert_eq!(r.text("D:displayname"), Some("Work"));
        assert_eq!(r.text("A:calendar-color"), Some("#FF8800FF"));
        assert_eq!(r.text("CS:getctag"), Some("ctag-7"));
        assert!(r.has_tag("D:current-user-privilege-set", "write-content"));
        assert!(r.has_tag("D:supported-report-set", "sync-collection"));
        assert_eq!(r.props["C:supported-calendar-component-set"].comps, vec!["VEVENT", "VTODO"]);
        assert_eq!(r.missing, vec!["D:sync-token"]);
        // the same document with explicit prefixes and another default
        let xml2 = r#"<D:multistatus xmlns:D="DAV:"><D:response><D:href>/a</D:href><D:status>HTTP/1.1 404 Not Found</D:status></D:response></D:multistatus>"#;
        let m2 = parse_multistatus(xml2).unwrap();
        assert_eq!((m2.responses[0].href.as_str(), m2.responses[0].status), ("/a", Some(404)));
    }

    #[test]
    fn hrefs_inside_properties_are_collected() {
        let xml = r#"<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:response><d:href>/principals/u/</d:href><d:propstat><d:prop>
            <c:calendar-home-set><d:href>/calendars/u/</d:href></c:calendar-home-set>
            <c:calendar-user-address-set><d:href>mailto:qa1@example.test</d:href><d:href>/principals/u/</d:href></c:calendar-user-address-set>
            <d:current-user-principal><d:href>/principals/u/</d:href></d:current-user-principal>
            </d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>"#;
        let r = &parse_multistatus(xml).unwrap().responses[0];
        assert_eq!(r.props["C:calendar-home-set"].hrefs, vec!["/calendars/u/"]);
        assert_eq!(r.props["C:calendar-user-address-set"].hrefs, vec!["mailto:qa1@example.test", "/principals/u/"]);
        assert_eq!(r.props["D:current-user-principal"].hrefs, vec!["/principals/u/"]);
    }

    #[test]
    fn what_is_not_a_multistatus_is_refused() {
        assert!(parse_multistatus("<html><body>Welcome</body></html>").unwrap_err().contains("not a multistatus"));
        assert!(parse_multistatus("not xml at all <").unwrap_err().contains("not XML"));
        assert!(parse_multistatus("").is_err());
    }

    #[test]
    fn error_bodies_name_their_condition() {
        let xml = r#"<D:error xmlns:D="DAV:"><D:valid-sync-token/></D:error>"#;
        assert_eq!(error_tags(xml), vec!["valid-sync-token"]);
        assert!(error_tags("<html/>").is_empty());
        assert!(error_tags("garbage").is_empty());
        assert_eq!(error_tags(r#"<d:error xmlns:d="DAV:"><d:need-privileges><d:resource/></d:need-privileges></d:error>"#), vec!["need-privileges", "resource"]);
    }

    #[test]
    fn request_bodies_are_well_formed_and_escape_what_they_carry() {
        for body in [propfind_principal(), propfind_home(), propfind_collections(), propfind_state(), propfind_etags(), sync_collection(""), sync_collection("tok&en<1>"), query_events(), multiget(&["/a/b&c.ics".to_string(), "/x y.ics".to_string()])] {
            Document::parse(&body).unwrap_or_else(|e| panic!("{e}: {body}"));
        }
        assert!(sync_collection("").contains("<D:sync-token/>"));
        assert!(sync_collection("t&1").contains("<D:sync-token>t&amp;1</D:sync-token>"));
        assert!(multiget(&["/a&b.ics".to_string()]).contains("<D:href>/a&amp;b.ics</D:href>"));
        assert!(propfind_collections().contains("<A:calendar-color/>") && propfind_collections().contains("<D:current-user-privilege-set/>"));
    }
}
