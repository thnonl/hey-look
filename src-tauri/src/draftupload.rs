//! Big pictures and attachments of a draft reach `save_draft` in pieces (1.0.7 D-045).
//!
//! One request with the whole draft - 14 pictures of a 19 MB draft are 25 million characters of base64 in one JSON text - keeps the app's main thread busy for 0.3 to
//! 0.5 s while the request is read (QA round 4: a webview round trip of 530 ms during the save of that draft; the page itself was blocked for 150 to 230 ms more). The same
//! bytes in 14 requests of 1.8 MB take as long in all and block nothing for longer than 45 ms. The page sends each big part with `draft_upload` first and then `save_draft`
//! with the part left empty and named in `uploads`; `resolve` puts the data back before anything else looks at the draft.

use crate::smtp::Draft;
use serde::Deserialize;
use std::sync::Mutex;
use std::time::{Duration, Instant};

type R<T> = Result<T, String>;

/// A part the page sent ahead: `inline` (a picture of the body) or an attachment, its position in the draft's list, and the id it was uploaded under.
#[derive(Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UploadRef {
    pub inline: bool,
    pub index: usize,
    pub id: String,
}

/// How long an upload waits for its `save_draft` (a save that never comes - the page was closed - must not keep megabytes for ever).
const TTL: Duration = Duration::from_secs(300);
/// What the uploads that wait may hold in all, in characters of base64 (the draft limit is 100 MB of message; the oldest go first).
const MAX_HELD: usize = 400_000_000;

static HELD: Mutex<Vec<(String, Instant, String)>> = Mutex::new(Vec::new());

fn held() -> std::sync::MutexGuard<'static, Vec<(String, Instant, String)>> {
    HELD.lock().unwrap_or_else(|p| p.into_inner())
}

/// Keep `data` (the base64 of a picture or an attachment) under `id` until `save_draft` asks for it.
pub fn put(id: String, data: String) {
    let mut h = held();
    h.retain(|(i, at, _)| *i != id && at.elapsed() < TTL);
    h.push((id, Instant::now(), data));
    while h.len() > 1 && h.iter().map(|(_, _, d)| d.len()).sum::<usize>() > MAX_HELD {
        h.remove(0);
    }
}

fn take(id: &str) -> Option<String> {
    let mut h = held();
    let at = h.iter().position(|(i, _, _)| i == id)?;
    Some(h.remove(at).2)
}

/// Fill the parts `uploads` names with their data. A part that was not uploaded (or was dropped meanwhile) is an error: the draft is not saved without it. The error is for
/// the page, not for the person: `api.saveDraft` answers it by sending the draft whole (it matches "draft upload missing").
pub fn resolve(draft: &mut Draft, uploads: Option<Vec<UploadRef>>) -> R<()> {
    for u in uploads.unwrap_or_default() {
        let data = take(&u.id).ok_or_else(|| "draft upload missing: a picture or file of this draft did not arrive".to_string())?;
        let slot = if u.inline { draft.inline.get_mut(u.index).map(|p| &mut p.data_base64) } else { draft.attachments.get_mut(u.index).map(|a| &mut a.data_base64) };
        *slot.ok_or_else(|| "draft upload missing: a picture or file of this draft did not arrive".to_string())? = data;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::smtp::{Att, InlineImage};

    fn draft() -> Draft {
        serde_json::from_value(serde_json::json!({
            "accountId": "a", "to": ["b@x.test"], "subject": "s", "html": "<p>x</p>", "text": "x",
            "attachments": [{ "filename": "f.bin", "mime": "application/octet-stream", "dataBase64": "" }, { "filename": "g.bin", "mime": "application/octet-stream", "dataBase64": "QUJD" }],
            "inline": [{ "cid": "c1", "filename": "p.png", "mime": "image/png", "dataBase64": "" }, { "cid": "c2", "filename": "q.png", "mime": "image/png", "dataBase64": "WFla" }]
        }))
        .unwrap()
    }

    #[test]
    fn the_uploaded_parts_go_back_into_the_draft_and_are_used_up() {
        let mut d = draft();
        put("t1-pic".into(), "AAAA".into());
        put("t1-file".into(), "BBBB".into());
        let refs = vec![UploadRef { inline: true, index: 0, id: "t1-pic".into() }, UploadRef { inline: false, index: 0, id: "t1-file".into() }];
        resolve(&mut d, Some(refs.clone())).unwrap();
        let (i, a): (&InlineImage, &Att) = (&d.inline[0], &d.attachments[0]);
        assert_eq!((i.data_base64.as_str(), a.data_base64.as_str()), ("AAAA", "BBBB"));
        assert_eq!(d.inline[1].data_base64, "WFla", "a part that was not uploaded is untouched");
        // used up: a second save with the same ids finds nothing
        assert!(resolve(&mut draft(), Some(refs)).unwrap_err().starts_with("draft upload missing"));
    }

    #[test]
    fn a_draft_without_uploads_is_left_alone_and_a_wrong_position_is_an_error() {
        let mut d = draft();
        resolve(&mut d, None).unwrap();
        resolve(&mut d, Some(vec![])).unwrap();
        assert_eq!(d.inline[0].data_base64, "");
        put("t2-pic".into(), "AAAA".into());
        assert!(resolve(&mut d, Some(vec![UploadRef { inline: true, index: 9, id: "t2-pic".into() }])).unwrap_err().starts_with("draft upload missing"));
    }

    #[test]
    fn uploads_that_wait_too_long_or_too_many_are_dropped() {
        put("t3-old".into(), "x".into());
        held().iter_mut().find(|(i, _, _)| i == "t3-old").unwrap().1 = Instant::now() - TTL - Duration::from_secs(1);
        put("t3-new".into(), "y".into()); // (a new upload clears out the expired ones)
        assert!(take("t3-old").is_none());
        assert_eq!(take("t3-new").as_deref(), Some("y"));
        // the same id again replaces the first
        put("t3-same".into(), "1".into());
        put("t3-same".into(), "2".into());
        assert_eq!(take("t3-same").as_deref(), Some("2"));
        assert!(take("t3-same").is_none());
    }
}
