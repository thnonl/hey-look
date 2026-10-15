//! Google Calendar API v3 provider (step 2).
use super::store::Source;
use super::{CalProvider, SyncErr};
use crate::Db;

pub fn provider(_db: &Db, _src: &Source) -> Result<Box<dyn CalProvider>, SyncErr> {
    Err(SyncErr::NotSetUp("Google Calendar sync is not part of this version".into()))
}
