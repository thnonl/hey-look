//! Windows: the access list of `test-bridge.json` (W9.4). The file holds the bridge token, and a file in the data folder inherits the folder's
//! access list, which on some machines lets other local users read it. `owner_only` gives the file ONE entry, the current user with full
//! control, and no inherited entries (a "protected" list), the Windows counterpart of mode 0600. Debug builds only (the test bridge is).

use std::path::Path;
use windows::core::PCWSTR;
use windows::Win32::Foundation::{CloseHandle, HANDLE, HLOCAL, LocalFree, WIN32_ERROR};
use windows::Win32::Security::Authorization::{SetEntriesInAclW, SetNamedSecurityInfoW, EXPLICIT_ACCESS_W, NO_MULTIPLE_TRUSTEE, SET_ACCESS, SE_FILE_OBJECT, TRUSTEE_IS_SID, TRUSTEE_IS_USER, TRUSTEE_W};
use windows::Win32::Security::{GetTokenInformation, NO_INHERITANCE, ACL, DACL_SECURITY_INFORMATION, PROTECTED_DACL_SECURITY_INFORMATION, TOKEN_QUERY, TOKEN_USER, TokenUser};
// (reading the list back is only for the test)
#[cfg(test)]
use windows::Win32::Security::Authorization::GetNamedSecurityInfoW;
#[cfg(test)]
use windows::Win32::Security::{GetAce, GetAclInformation, GetSecurityDescriptorControl, AclSizeInformation, EqualSid, ACL_SIZE_INFORMATION, PSECURITY_DESCRIPTOR, PSID, SE_DACL_PROTECTED};
use windows::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

/// FILE_ALL_ACCESS (standard rights + every file right)
const FILE_ALL_ACCESS: u32 = 0x001F_01FF;

fn wide(p: &Path) -> Vec<u16> {
    use std::os::windows::ffi::OsStrExt;
    p.as_os_str().encode_wide().chain(std::iter::once(0)).collect()
}

fn check(code: WIN32_ERROR, what: &str) -> Result<(), String> {
    if code.0 == 0 { Ok(()) } else { Err(format!("{what} failed (error {})", code.0)) }
}

/// The SID of the user this process runs as, in a buffer that stays valid as long as the returned Vec does.
fn current_user_sid() -> Result<Vec<u8>, String> {
    unsafe {
        let mut token = HANDLE::default();
        OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token).map_err(|e| format!("OpenProcessToken: {e}"))?;
        let mut len = 0u32;
        let _ = GetTokenInformation(token, TokenUser, None, 0, &mut len);
        let mut buf = vec![0u8; len as usize];
        let r = GetTokenInformation(token, TokenUser, Some(buf.as_mut_ptr().cast()), len, &mut len);
        let _ = CloseHandle(token);
        r.map_err(|e| format!("GetTokenInformation: {e}"))?;
        Ok(buf)
    }
}

/// Gives `path` an access list with one entry, the current user with full control, and no inherited entries.
pub fn owner_only(path: &Path) -> Result<(), String> {
    let user = current_user_sid()?;
    let user = unsafe { &*(user.as_ptr() as *const TOKEN_USER) };
    let sid = user.User.Sid;
    let ea = EXPLICIT_ACCESS_W {
        grfAccessPermissions: FILE_ALL_ACCESS,
        grfAccessMode: SET_ACCESS,
        grfInheritance: NO_INHERITANCE,
        Trustee: TRUSTEE_W {
            pMultipleTrustee: std::ptr::null_mut(),
            MultipleTrusteeOperation: NO_MULTIPLE_TRUSTEE,
            TrusteeForm: TRUSTEE_IS_SID,
            TrusteeType: TRUSTEE_IS_USER,
            ptstrName: windows::core::PWSTR(sid.0.cast()),
        },
    };
    unsafe {
        let mut acl: *mut ACL = std::ptr::null_mut();
        check(SetEntriesInAclW(Some(&[ea]), None, &mut acl), "SetEntriesInAclW")?;
        let w = wide(path);
        let r = SetNamedSecurityInfoW(PCWSTR(w.as_ptr()), SE_FILE_OBJECT, DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION, None, None, Some(acl), None);
        let _ = LocalFree(Some(HLOCAL(acl.cast())));
        check(r, "SetNamedSecurityInfoW")
    }
}

#[cfg(test)]
/// What the access list of `path` holds: (number of entries, whether the only entry is the current user's, whether the list is protected from inheritance).
pub fn describe(path: &Path) -> Result<(u32, bool, bool), String> {
    let user = current_user_sid()?;
    let user = unsafe { &*(user.as_ptr() as *const TOKEN_USER) };
    unsafe {
        let w = wide(path);
        let mut dacl: *mut ACL = std::ptr::null_mut();
        let mut sd = PSECURITY_DESCRIPTOR::default();
        check(GetNamedSecurityInfoW(PCWSTR(w.as_ptr()), SE_FILE_OBJECT, DACL_SECURITY_INFORMATION, None, None, Some(&mut dacl), None, &mut sd), "GetNamedSecurityInfoW")?;
        let mut info = ACL_SIZE_INFORMATION::default();
        GetAclInformation(dacl, (&mut info as *mut ACL_SIZE_INFORMATION).cast(), std::mem::size_of::<ACL_SIZE_INFORMATION>() as u32, AclSizeInformation).map_err(|e| format!("GetAclInformation: {e}"))?;
        let mut only_me = info.AceCount == 1;
        if only_me {
            let mut ace: *mut core::ffi::c_void = std::ptr::null_mut();
            GetAce(dacl, 0, &mut ace).map_err(|e| format!("GetAce: {e}"))?;
            // ACCESS_ALLOWED_ACE: header (4 bytes), access mask (4 bytes), then the SID
            let ace_sid = PSID(ace.cast::<u8>().add(8).cast());
            only_me = EqualSid(ace_sid, user.User.Sid).is_ok();
        }
        let mut control = 0u16;
        let mut rev = 0u32;
        GetSecurityDescriptorControl(sd, &mut control, &mut rev).map_err(|e| format!("GetSecurityDescriptorControl: {e}"))?;
        let protected = control & (SE_DACL_PROTECTED.0 as u16) != 0;
        let _ = LocalFree(Some(HLOCAL(sd.0)));
        Ok((info.AceCount, only_me, protected))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// W9.4 (AC-9.4.3): a file in a temp folder gets one entry, the current user's, with no inherited entries.
    #[test]
    fn the_token_file_has_one_entry_for_the_current_user_and_inherits_nothing() {
        let dir = std::env::temp_dir().join(format!("hey-look-acl-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join(super::super::INFO_FILE);
        std::fs::write(&p, b"{}").unwrap();
        let (before, _, _) = describe(&p).unwrap();
        owner_only(&p).unwrap();
        let (count, only_me, protected) = describe(&p).unwrap();
        assert_eq!(count, 1, "one entry (before: {before})");
        assert!(only_me, "the entry is the current user's");
        assert!(protected, "inherited entries are cut off");
        // and the owner can still read and rewrite it
        std::fs::write(&p, b"{\"a\":1}").unwrap();
        assert_eq!(std::fs::read_to_string(&p).unwrap(), "{\"a\":1}");
        let _ = std::fs::remove_file(&p);
        let _ = std::fs::remove_dir(&dir);
    }
}
