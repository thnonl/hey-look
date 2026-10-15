//! OpenPGP primitives on top of the pure-Rust `pgp` crate (rPGP): key generation, parsing, import/export,
//! passphrase handling, encryption, signing and verification. No database and no I/O here, so everything
//! is unit-testable. MIME framing lives in `pgpmail`, storage and Tauri commands in `pgpstore`.

use crate::db::{err, R};
use pgp::composed::{
    ArmorOptions, Deserializable, DetachedSignature, EncryptionCaps, KeyType, Message, MessageBuilder, SecretKeyParamsBuilder,
    SignedPublicKey, SignedPublicSubKey, SignedSecretKey, SubkeyParamsBuilder,
};
use pgp::crypto::ecc_curve::ECCCurve;
use pgp::crypto::hash::HashAlgorithm;
use pgp::crypto::sym::SymmetricKeyAlgorithm;
use pgp::packet::{PacketTrait, Subpacket, SubpacketData};
use pgp::packet::{SignatureConfig, SignatureType};
use pgp::ser::Serialize as PgpSerialize;
use pgp::types::{KeyDetails as _, Password, PublicParams, SecretParams, SigningKey};
use rand08::thread_rng;
use serde::Serialize;
use std::io::Cursor;

pub fn now() -> i64 {
    chrono::Utc::now().timestamp()
}

fn hex_upper(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02X}")).collect()
}

/// Everything the UI shows about one key (public data only).
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct KeyInfo {
    /// 40 hex characters (upper case, no spaces)
    pub fingerprint: String,
    /// last 16 hex characters of the fingerprint
    pub key_id: String,
    pub user_ids: Vec<String>,
    pub algo: String,
    pub created: i64,
    pub expires: Option<i64>,
    pub expired: bool,
    pub revoked: bool,
    pub has_secret: bool,
}

/// A parsed key block: public certificate or transferable secret key.
pub enum Material {
    Public(SignedPublicKey),
    Secret(SignedSecretKey),
}

impl Material {
    pub fn public(&self) -> SignedPublicKey {
        match self {
            Material::Public(p) => p.clone(),
            Material::Secret(s) => s.to_public_key(),
        }
    }
    pub fn is_secret(&self) -> bool {
        matches!(self, Material::Secret(_))
    }
}

// ---------------------------------------------------------------------------------------------------------------
// parsing and key info

fn blocks<'a>(text: &'a str, kind: &str) -> Vec<&'a str> {
    let begin = format!("-----BEGIN PGP {kind} BLOCK-----");
    let end = format!("-----END PGP {kind} BLOCK-----");
    let mut out = vec![];
    let mut rest = text;
    while let Some(a) = rest.find(&begin) {
        let Some(b) = rest[a..].find(&end) else { break };
        let stop = a + b + end.len();
        out.push(&rest[a..stop]);
        rest = &rest[stop..];
    }
    out
}

/// Parse armored or binary key material (public and/or secret keys, one or many).
pub fn parse_material(data: &[u8]) -> R<Vec<Material>> {
    let mut out: Vec<Material> = vec![];
    let text = std::str::from_utf8(data).ok().filter(|t| t.contains("-----BEGIN PGP"));
    if let Some(text) = text {
        for b in blocks(text, "PRIVATE KEY") {
            let (it, _) = SignedSecretKey::from_string_many(b).map_err(|e| crate::i18n::coded("PGP_BAD_KEY_DETAIL", &[("detail", &e.to_string())], &format!("This doesn't look like an OpenPGP key. ({e})")))?;
            for k in it {
                out.push(Material::Secret(k.map_err(|e| crate::i18n::coded("PGP_BAD_KEY_DETAIL", &[("detail", &e.to_string())], &format!("This doesn't look like an OpenPGP key. ({e})")))?));
            }
        }
        for b in blocks(text, "PUBLIC KEY") {
            let (it, _) = SignedPublicKey::from_string_many(b).map_err(|e| crate::i18n::coded("PGP_BAD_KEY_DETAIL", &[("detail", &e.to_string())], &format!("This doesn't look like an OpenPGP key. ({e})")))?;
            for k in it {
                out.push(Material::Public(k.map_err(|e| crate::i18n::coded("PGP_BAD_KEY_DETAIL", &[("detail", &e.to_string())], &format!("This doesn't look like an OpenPGP key. ({e})")))?));
            }
        }
    } else {
        // binary keyring: secret first, then public
        if let Ok(it) = SignedSecretKey::from_bytes_many(Cursor::new(data.to_vec())) {
            let v: Vec<_> = it.filter_map(|k| k.ok()).collect();
            out.extend(v.into_iter().map(Material::Secret));
        }
        if out.is_empty() {
            if let Ok(it) = SignedPublicKey::from_bytes_many(Cursor::new(data.to_vec())) {
                let v: Vec<_> = it.filter_map(|k| k.ok()).collect();
                out.extend(v.into_iter().map(Material::Public));
            }
        }
    }
    if out.is_empty() {
        return Err("PGP_BAD_KEY: This doesn't look like an OpenPGP key.".into());
    }
    for m in &out {
        let ok = match m {
            Material::Public(k) => k.verify_bindings(),
            Material::Secret(k) => k.verify_bindings(),
        };
        ok.map_err(|e| crate::i18n::coded("PGP_BAD_KEY_SIG", &[("detail", &e.to_string())], &format!("This key's signatures are not valid. ({e})")))?;
    }
    Ok(out)
}

pub fn fingerprint(pk: &SignedPublicKey) -> String {
    hex_upper(pk.fingerprint().as_bytes())
}

fn key_id_of(fp: &str) -> String {
    fp[fp.len().saturating_sub(16)..].to_string()
}

fn sig_exp_secs(s: &pgp::packet::Signature) -> Option<u64> {
    s.key_expiration_time().map(|d| std::time::Duration::from(d).as_secs()).filter(|&e| e > 0)
}

/// Expiry (unix seconds) from the newest self-signature that carries one.
pub fn key_expiry(pk: &SignedPublicKey) -> Option<i64> {
    let created = pk.primary_key.created_at().as_secs() as i64;
    let mut best: Option<(u32, Option<u64>)> = None;
    let sigs = pk.details.users.iter().flat_map(|u| u.signatures.iter()).chain(pk.details.direct_signatures.iter());
    for s in sigs {
        let c = s.created().map(|t| t.as_secs()).unwrap_or(0);
        if best.is_none_or(|(bc, _)| c >= bc) {
            best = Some((c, sig_exp_secs(s)));
        }
    }
    best.and_then(|(_, e)| e).map(|e| created + e as i64)
}

pub fn is_revoked(pk: &SignedPublicKey) -> bool {
    !pk.details.revocation_signatures.is_empty()
}

pub fn user_ids(pk: &SignedPublicKey) -> Vec<String> {
    pk.details.users.iter().filter_map(|u| u.id.as_str().map(|s| s.to_string())).collect()
}

fn algo_text(pk: &SignedPublicKey) -> String {
    match pk.primary_key.public_params() {
        PublicParams::RSA(_) => {
            let mut buf = vec![];
            let bits = pk.primary_key.public_params().to_writer(&mut buf).ok().filter(|_| buf.len() > 2).map(|_| u16::from_be_bytes([buf[0], buf[1]]));
            match bits {
                Some(b) => format!("RSA {b}"),
                None => "RSA".into(),
            }
        }
        PublicParams::EdDSALegacy(_) | PublicParams::Ed25519(_) => {
            if pk.public_subkeys.iter().any(|s| matches!(s.key.public_params(), PublicParams::ECDH(_) | PublicParams::X25519(_))) {
                "Ed25519 / Curve25519".into()
            } else {
                "Ed25519".into()
            }
        }
        PublicParams::ECDSA(_) => "ECDSA".into(),
        PublicParams::DSA(_) => "DSA".into(),
        _ => "OpenPGP".into(),
    }
}

pub fn info(pk: &SignedPublicKey, has_secret: bool) -> KeyInfo {
    let fp = fingerprint(pk);
    let expires = key_expiry(pk);
    KeyInfo {
        key_id: key_id_of(&fp),
        fingerprint: fp,
        user_ids: user_ids(pk),
        algo: algo_text(pk),
        created: pk.primary_key.created_at().as_secs() as i64,
        expires,
        expired: expires.is_some_and(|e| e <= now()),
        revoked: is_revoked(pk),
        has_secret,
    }
}

/// All key ids (long, upper hex) of a certificate: primary key and every subkey.
pub fn all_key_ids(pk: &SignedPublicKey) -> Vec<String> {
    let mut v = vec![key_id_of(&fingerprint(pk))];
    for s in &pk.public_subkeys {
        v.push(key_id_of(&hex_upper(s.fingerprint().as_bytes())));
    }
    v
}

/// Lower-case e-mail addresses of the user IDs ("Name <a@b.c>" or a bare address).
pub fn emails_of(uids: &[String]) -> Vec<String> {
    let mut out: Vec<String> = vec![];
    for u in uids {
        let e = match (u.rfind('<'), u.rfind('>')) {
            (Some(a), Some(b)) if a < b => u[a + 1..b].trim().to_string(),
            _ if u.contains('@') && !u.contains(' ') => u.trim().to_string(),
            _ => continue,
        };
        let e = e.to_lowercase();
        if e.contains('@') && !out.contains(&e) {
            out.push(e);
        }
    }
    out
}

// ---------------------------------------------------------------------------------------------------------------
// generation, passphrase, expiry

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Algo {
    /// Ed25519 + Curve25519 (v4 keys: understood by every GnuPG 2.x)
    Cv25519,
    /// RSA 3072: slower, understood by everything
    Rsa3072,
}

impl Algo {
    pub fn parse(s: &str) -> R<Algo> {
        match s {
            "cv25519" => Ok(Algo::Cv25519),
            "rsa3072" | "rsa4096" => Ok(Algo::Rsa3072),
            _ => Err(format!("unknown key type '{s}'")),
        }
    }
}

pub fn generate(algo: Algo, user_id: &str, expires_days: Option<u32>, passphrase: &str) -> R<SignedSecretKey> {
    let (primary, enc) = match algo {
        Algo::Cv25519 => (KeyType::Ed25519Legacy, KeyType::ECDH(ECCCurve::Curve25519Legacy)),
        Algo::Rsa3072 => (KeyType::Rsa(3072), KeyType::Rsa(3072)),
    };
    let pw = (!passphrase.is_empty()).then(|| passphrase.to_string());
    let mut sub = SubkeyParamsBuilder::default();
    sub.key_type(enc).can_encrypt(EncryptionCaps::All).can_sign(false).can_authenticate(false).passphrase(pw.clone());
    let mut params = SecretKeyParamsBuilder::default();
    params
        .key_type(primary)
        .can_certify(true)
        .can_sign(true)
        .can_encrypt(EncryptionCaps::None)
        .primary_user_id(user_id.to_string())
        .passphrase(pw)
        .preferred_symmetric_algorithms(smallvec::smallvec![SymmetricKeyAlgorithm::AES256, SymmetricKeyAlgorithm::AES128])
        .preferred_hash_algorithms(smallvec::smallvec![HashAlgorithm::Sha256, HashAlgorithm::Sha512])
        .subkeys(vec![sub.build().map_err(err)?]);
    let mut key = params.build().map_err(err)?.generate(thread_rng()).map_err(err)?;
    if expires_days.is_some() {
        set_expiry(&mut key, passphrase, expires_days)?;
    }
    Ok(key)
}

/// Re-issue the self-signatures of every user ID with a new expiry (`None` = never expires).
pub fn set_expiry(key: &mut SignedSecretKey, passphrase: &str, days: Option<u32>) -> R<()> {
    let pw = Password::from(passphrase);
    let mut rng = thread_rng();
    let primary = key.primary_key.clone();
    for user in key.details.users.iter_mut() {
        let old = user.signatures.iter().filter(|s| s.is_certification()).max_by_key(|s| s.created().map(|t| t.as_secs()).unwrap_or(0)).cloned();
        let mut config = SignatureConfig::from_key(&mut rng, &primary, SignatureType::CertPositive).map_err(err)?;
        let mut hashed: Vec<Subpacket> = old
            .as_ref()
            .and_then(|o| o.config())
            .map(|c| {
                c.hashed_subpackets
                    .iter()
                    .filter(|p| !matches!(p.data, SubpacketData::SignatureCreationTime(_) | SubpacketData::KeyExpirationTime(_)))
                    .cloned()
                    .collect()
            })
            .unwrap_or_default();
        hashed.push(Subpacket::regular(SubpacketData::SignatureCreationTime(pgp::types::Timestamp::now())).map_err(err)?);
        if let Some(d) = days {
            let dur = pgp::types::Duration::try_from(std::time::Duration::from_secs(d as u64 * 86400)).map_err(err)?;
            hashed.push(Subpacket::regular(SubpacketData::KeyExpirationTime(dur)).map_err(err)?);
        }
        config.hashed_subpackets = hashed;
        config.unhashed_subpackets = old
            .as_ref()
            .and_then(|o| o.config())
            .map(|c| c.unhashed_subpackets.clone())
            .unwrap_or_default();
        let sig = config
            .sign_certification(&primary, primary.public_key(), &pw, user.id.tag(), &user.id)
            .map_err(|_| "PGP_BAD_PASSPHRASE: Wrong passphrase.".to_string())?;
        user.signatures = vec![sig];
    }
    Ok(())
}

pub fn is_protected(sk: &SignedSecretKey) -> bool {
    matches!(sk.primary_key.secret_params(), SecretParams::Encrypted(_))
}

/// A copy of the secret key with the passphrase removed (kept in memory only). Fails on a wrong passphrase.
pub fn unlock_clone(sk: &SignedSecretKey, passphrase: &str) -> R<SignedSecretKey> {
    let pw = Password::from(passphrase);
    let mut c = sk.clone();
    let bad = |_| "PGP_BAD_PASSPHRASE: Wrong passphrase. Try again.".to_string();
    c.primary_key.remove_password(&pw).map_err(bad)?;
    for s in c.secret_subkeys.iter_mut() {
        s.key.remove_password(&pw).map_err(bad)?;
    }
    Ok(c)
}

/// Protect an unlocked key with a (new) passphrase.
pub fn lock_with(sk: &mut SignedSecretKey, passphrase: &str) -> R<()> {
    let pw = Password::from(passphrase);
    let mut rng = thread_rng();
    if passphrase.is_empty() {
        return Ok(());
    }
    sk.primary_key.set_password(&mut rng, &pw).map_err(err)?;
    for s in sk.secret_subkeys.iter_mut() {
        s.key.set_password(&mut rng, &pw).map_err(err)?;
    }
    Ok(())
}

pub fn change_passphrase(sk: &SignedSecretKey, old: &str, new: &str) -> R<SignedSecretKey> {
    let mut c = unlock_clone(sk, old)?;
    lock_with(&mut c, new)?;
    Ok(c)
}

pub fn armor_public(pk: &SignedPublicKey) -> R<String> {
    pk.to_armored_string(ArmorOptions::default()).map_err(err)
}

pub fn armor_secret(sk: &SignedSecretKey) -> R<String> {
    sk.to_armored_string(ArmorOptions::default()).map_err(err)
}

pub fn parse_public(armored: &str) -> R<SignedPublicKey> {
    SignedPublicKey::from_string(armored).map(|(k, _)| k).map_err(err)
}

pub fn parse_secret(armored: &str) -> R<SignedSecretKey> {
    SignedSecretKey::from_string(armored).map(|(k, _)| k).map_err(err)
}

// ---------------------------------------------------------------------------------------------------------------
// key usability

#[derive(Debug, PartialEq, Eq, Clone)]
pub enum Unusable {
    Expired(i64),
    Revoked,
    NoEncryptionKey,
}

pub enum EncKey<'a> {
    Sub(&'a SignedPublicSubKey),
    Primary(&'a SignedPublicKey),
}

fn newest<'a>(sigs: &'a [pgp::packet::Signature], typ: SignatureType) -> Option<&'a pgp::packet::Signature> {
    sigs.iter().filter(|s| s.typ() == Some(typ)).max_by_key(|s| s.created().map(|t| t.as_secs()).unwrap_or(0))
}

/// The subkey (or primary key) to encrypt to, or why the certificate cannot be used right now.
pub fn encryption_key(pk: &SignedPublicKey, at: i64) -> Result<EncKey<'_>, Unusable> {
    if is_revoked(pk) {
        return Err(Unusable::Revoked);
    }
    if let Some(e) = key_expiry(pk) {
        if e <= at {
            return Err(Unusable::Expired(e));
        }
    }
    let mut best: Option<(&SignedPublicSubKey, i64)> = None;
    let mut sub_problem: Option<Unusable> = None;
    for s in &pk.public_subkeys {
        let Some(bind) = newest(&s.signatures, SignatureType::SubkeyBinding) else { continue };
        let f = bind.key_flags();
        if !(f.encrypt_comms() || f.encrypt_storage()) {
            continue;
        }
        if s.signatures.iter().any(|x| x.typ() == Some(SignatureType::SubkeyRevocation)) {
            sub_problem = Some(Unusable::Revoked);
            continue;
        }
        let created = s.created_at().as_secs() as i64;
        if let Some(e) = sig_exp_secs(bind) {
            if created + e as i64 <= at {
                sub_problem = Some(Unusable::Expired(created + e as i64));
                continue;
            }
        }
        if best.is_none_or(|(_, c)| created >= c) {
            best = Some((s, created));
        }
    }
    if let Some((s, _)) = best {
        return Ok(EncKey::Sub(s));
    }
    if let Some(p) = sub_problem {
        return Err(p);
    }
    let flags = pk
        .details
        .users
        .iter()
        .flat_map(|u| u.signatures.iter())
        .filter(|s| s.is_certification())
        .max_by_key(|s| s.created().map(|t| t.as_secs()).unwrap_or(0))
        .map(|s| s.key_flags());
    let rsa = matches!(pk.primary_key.public_params(), PublicParams::RSA(_));
    match flags {
        Some(f) if f.encrypt_comms() || f.encrypt_storage() => Ok(EncKey::Primary(pk)),
        None if rsa => Ok(EncKey::Primary(pk)),
        _ if rsa && pk.public_subkeys.is_empty() => Ok(EncKey::Primary(pk)),
        _ => Err(Unusable::NoEncryptionKey),
    }
}

// ---------------------------------------------------------------------------------------------------------------
// signing

enum Signer<'a> {
    Primary(&'a pgp::packet::SecretKey),
    Sub(&'a pgp::packet::SecretSubkey),
}

fn pick_signer(sk: &SignedSecretKey) -> R<Signer<'_>> {
    let pflags = sk
        .details
        .users
        .iter()
        .flat_map(|u| u.signatures.iter())
        .filter(|s| s.is_certification())
        .max_by_key(|s| s.created().map(|t| t.as_secs()).unwrap_or(0))
        .map(|s| s.key_flags());
    let primary_signs = match &pflags {
        Some(f) => f.sign(),
        None => true,
    };
    if primary_signs {
        return Ok(Signer::Primary(&sk.primary_key));
    }
    for s in &sk.secret_subkeys {
        if let Some(b) = newest(&s.signatures, SignatureType::SubkeyBinding) {
            if b.key_flags().sign() {
                return Ok(Signer::Sub(&s.key));
            }
        }
    }
    Err("PGP_NO_SIGN_CAP: This key has no signing capability.".into())
}

/// The RFC 3156 `micalg` parameter for the hash a signature was made with. A hash without a registered name is an error:
/// labelling it `pgp-sha256` would make the receiving client check the signature against the wrong digest.
pub fn micalg(h: HashAlgorithm) -> R<String> {
    Ok(match h {
        HashAlgorithm::Md5 => "pgp-md5",
        HashAlgorithm::Sha1 => "pgp-sha1",
        HashAlgorithm::Ripemd160 => "pgp-ripemd160",
        HashAlgorithm::Sha256 => "pgp-sha256",
        HashAlgorithm::Sha224 => "pgp-sha224",
        HashAlgorithm::Sha384 => "pgp-sha384",
        HashAlgorithm::Sha512 => "pgp-sha512",
        other => return Err(format!("PGP_FAILED: This key signs with a hash ({other:?}) that cannot be used in a signed email.")),
    }
    .to_string())
}

/// Detached ASCII-armored signature (text mode) over `data`. Returns (armored signature, micalg).
/// The key must be unlocked or pass the right `passphrase`.
pub fn sign_detached(sk: &SignedSecretKey, passphrase: &str, data: &[u8]) -> R<(String, String)> {
    let pw = Password::from(passphrase);
    let bad = |e: pgp::errors::Error| format!("PGP_FAILED: Couldn't sign: {e}");
    let (sig, hash) = match pick_signer(sk)? {
        Signer::Primary(k) => {
            let h = k.hash_alg();
            (DetachedSignature::sign_text_data(thread_rng(), k, &pw, h, data).map_err(bad)?, h)
        }
        Signer::Sub(k) => {
            let h = k.hash_alg();
            (DetachedSignature::sign_text_data(thread_rng(), k, &pw, h, data).map_err(bad)?, h)
        }
    };
    let armored = sig.to_armored_string(ArmorOptions::default()).map_err(err)?;
    Ok((armored, micalg(hash)?))
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SigVerdict {
    /// valid | invalid | unknown_key | expired_key | revoked_key
    pub status: String,
    pub key_id: String,
    /// fingerprint of the certificate that signed (when its key is known)
    pub fingerprint: Option<String>,
    pub signed_at: Option<i64>,
}

fn issuer_ids(sig: &pgp::packet::Signature) -> (Vec<String>, Vec<String>) {
    let fps = sig.issuer_fingerprint().iter().map(|f| hex_upper(f.as_bytes())).collect();
    let ids = sig.issuer_key_id().iter().map(|k| hex_upper(k.as_ref())).collect();
    (fps, ids)
}

enum Candidate<'a> {
    Primary(&'a SignedPublicKey),
    Sub(&'a SignedPublicKey, &'a SignedPublicSubKey),
}

fn find_candidate<'a>(keys: &'a [SignedPublicKey], fps: &[String], ids: &[String]) -> Option<Candidate<'a>> {
    for k in keys {
        let kfp = fingerprint(k);
        if fps.iter().any(|f| *f == kfp) || ids.iter().any(|i| *i == key_id_of(&kfp)) {
            return Some(Candidate::Primary(k));
        }
        for s in &k.public_subkeys {
            let sfp = hex_upper(s.fingerprint().as_bytes());
            if fps.iter().any(|f| *f == sfp) || ids.iter().any(|i| *i == key_id_of(&sfp)) {
                return Some(Candidate::Sub(k, s));
            }
        }
    }
    None
}

fn verdict_for(cert: &SignedPublicKey, ok: bool, key_id: String, signed_at: Option<i64>) -> SigVerdict {
    let fpr = fingerprint(cert);
    let status = if !ok {
        "invalid"
    } else if is_revoked(cert) {
        "revoked_key"
    } else if key_expiry(cert).is_some_and(|e| e <= now()) {
        "expired_key"
    } else {
        "valid"
    };
    SigVerdict { status: status.into(), key_id, fingerprint: Some(fpr), signed_at }
}

fn unknown(key_id: String, signed_at: Option<i64>) -> SigVerdict {
    SigVerdict { status: "unknown_key".into(), key_id, fingerprint: None, signed_at }
}

fn best_id(fps: &[String], ids: &[String]) -> String {
    fps.first().map(|f| key_id_of(f)).or_else(|| ids.first().cloned()).unwrap_or_default()
}

/// Verify a detached armored (or binary) signature over `data` against the known certificates.
pub fn verify_detached(sig_data: &[u8], data: &[u8], keys: &[SignedPublicKey]) -> SigVerdict {
    let parsed = match std::str::from_utf8(sig_data).ok().filter(|t| t.contains("-----BEGIN PGP")) {
        Some(t) => DetachedSignature::from_string(t).map(|(s, _)| s),
        None => DetachedSignature::from_bytes(Cursor::new(sig_data.to_vec())),
    };
    let Ok(sig) = parsed else {
        return SigVerdict { status: "invalid".into(), key_id: String::new(), fingerprint: None, signed_at: None };
    };
    let (fps, ids) = issuer_ids(&sig.signature);
    let kid = best_id(&fps, &ids);
    let at = sig.signature.created().map(|t| t.as_secs() as i64);
    match find_candidate(keys, &fps, &ids) {
        None => unknown(kid, at),
        Some(Candidate::Primary(k)) => verdict_for(k, sig.verify(&k.primary_key, data).is_ok(), kid, at),
        Some(Candidate::Sub(k, s)) => verdict_for(k, sig.verify(s, data).is_ok(), kid, at),
    }
}

// ---------------------------------------------------------------------------------------------------------------
// encryption and decryption

pub struct Recipient<'a> {
    pub key: &'a SignedPublicKey,
    /// Bcc: do not put the key id in the message (the recipient tries its keys)
    pub hidden: bool,
}

/// Why a certificate cannot be used for encryption, as a short human phrase.
pub fn unusable_text(u: &Unusable) -> String {
    match u {
        Unusable::Expired(_) => "its key expired".into(),
        Unusable::Revoked => "its key was revoked".into(),
        Unusable::NoEncryptionKey => "it has no encryption key".into(),
    }
}

/// Encrypt `plain` (a MIME entity) to every recipient, optionally signing it first (OpenPGP signature inside
/// the encryption layer). Returns the ASCII-armored message.
pub fn encrypt(plain: &[u8], recipients: &[Recipient], signer: Option<(&SignedSecretKey, &str)>) -> R<String> {
    if recipients.is_empty() {
        return Err("PGP_FAILED: no recipients to encrypt for".into());
    }
    let mut rng = thread_rng();
    let mut b = MessageBuilder::from_bytes("", plain.to_vec()).seipd_v1(&mut rng, SymmetricKeyAlgorithm::AES256);
    let signing: Option<(Signer, String)> = match signer {
        Some((sk, pw)) => Some((pick_signer(sk)?, pw.to_string())),
        None => None,
    };
    if let Some((s, pw)) = &signing {
        match s {
            Signer::Primary(k) => {
                b.sign(*k, Password::from(pw.as_str()), k.hash_alg());
            }
            Signer::Sub(k) => {
                b.sign(*k, Password::from(pw.as_str()), k.hash_alg());
            }
        }
    }
    let t = now();
    for r in recipients {
        let k = encryption_key(r.key, t).map_err(|u| format!("PGP_FAILED: can't encrypt for {}: {}", user_ids(r.key).first().cloned().unwrap_or_default(), unusable_text(&u)))?;
        let res = match (k, r.hidden) {
            (EncKey::Sub(s), false) => b.encrypt_to_key(&mut rng, s),
            (EncKey::Sub(s), true) => b.encrypt_to_key_anonymous(&mut rng, s),
            (EncKey::Primary(p), false) => b.encrypt_to_key(&mut rng, &p.primary_key),
            (EncKey::Primary(p), true) => b.encrypt_to_key_anonymous(&mut rng, &p.primary_key),
        };
        res.map_err(|e| crate::i18n::coded("PGP_ENCRYPT_FAILED", &[("detail", &e.to_string())], &format!("Couldn't encrypt: {e}")))?;
    }
    b.to_armored_string(&mut rng, ArmorOptions::default()).map_err(|e| crate::i18n::coded("PGP_ENCRYPT_FAILED", &[("detail", &e.to_string())], &format!("Couldn't encrypt: {e}")))
}

/// Key ids (upper hex) the message is encrypted for. An empty id means "anonymous recipient".
pub fn encrypted_for(cipher: &[u8]) -> R<Vec<String>> {
    let msg = parse_message(cipher)?;
    let mut out = vec![];
    if let Message::Encrypted { esk, .. } = &msg {
        for e in esk {
            if let pgp::composed::Esk::PublicKeyEncryptedSessionKey(p) = e {
                if let Ok(id) = p.id() {
                    let h = hex_upper(id.as_ref());
                    out.push(if h.chars().all(|c| c == '0') { String::new() } else { h });
                }
            }
        }
    }
    Ok(out)
}

fn parse_message(cipher: &[u8]) -> R<Message<'static>> {
    let armored = std::str::from_utf8(cipher).ok().filter(|t| t.contains("-----BEGIN PGP"));
    match armored {
        Some(t) => Message::from_armor(Cursor::new(t.as_bytes().to_vec())).map(|(m, _)| m).map_err(|e| crate::i18n::coded("PGP_DATA_UNREADABLE", &[("detail", &e.to_string())], &format!("The PGP data could not be read ({e})"))),
        None => Message::from_bytes(Cursor::new(cipher.to_vec())).map_err(|e| crate::i18n::coded("PGP_DATA_UNREADABLE", &[("detail", &e.to_string())], &format!("The PGP data could not be read ({e})"))),
    }
}

#[derive(Debug)]
pub enum DecryptError {
    /// none of the given keys matches
    NoKey,
    Bad(String),
}

pub struct Decrypted {
    pub data: Vec<u8>,
    /// verdicts for signatures inside the encrypted message (empty = not signed)
    pub signatures: Vec<SigVerdict>,
}

/// Decrypt with unlocked secret keys, verifying signatures inside against `verifiers`.
pub fn decrypt(cipher: &[u8], keys: &[&SignedSecretKey], verifiers: &[SignedPublicKey]) -> Result<Decrypted, DecryptError> {
    let msg = parse_message(cipher).map_err(DecryptError::Bad)?;
    if !msg.is_encrypted() {
        return Err(DecryptError::Bad("This isn't an encrypted message.".into()));
    }
    let empty = Password::empty();
    let pws: Vec<&Password> = keys.iter().map(|_| &empty).collect();
    let dec = msg.decrypt_with_keys(pws, keys.to_vec()).map_err(|e| match e {
        pgp::errors::Error::MissingKey => DecryptError::NoKey,
        other => DecryptError::Bad(other.to_string()),
    })?;
    read_plain(dec, verifiers)
}

/// Read a (possibly compressed, possibly signed) message; used after decryption and for plain signed messages.
pub fn read_plain(mut m: Message<'_>, verifiers: &[SignedPublicKey]) -> Result<Decrypted, DecryptError> {
    let bad = |e: &dyn std::fmt::Display| DecryptError::Bad(e.to_string());
    let mut guard = 0;
    while m.is_compressed() && guard < 4 {
        m = m.decompress().map_err(|e| bad(&e))?;
        guard += 1;
    }
    let data = m.as_data_vec().map_err(|e| bad(&e))?;
    let mut signatures = vec![];
    if let Message::Signed { reader, .. } = &m {
        for i in 0..reader.num_signatures() {
            let Some(sig) = reader.signature(i) else { continue };
            let (fps, ids) = issuer_ids(sig);
            let kid = best_id(&fps, &ids);
            let at = sig.created().map(|t| t.as_secs() as i64);
            signatures.push(match find_candidate(verifiers, &fps, &ids) {
                None => unknown(kid, at),
                Some(Candidate::Primary(k)) => verdict_for(k, m.verify_nested_explicit(i, &k.primary_key).is_ok(), kid, at),
                Some(Candidate::Sub(k, s)) => verdict_for(k, m.verify_nested_explicit(i, s).is_ok(), kid, at),
            });
        }
    }
    Ok(Decrypted { data, signatures })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mkkey(email: &str, pw: &str) -> SignedSecretKey {
        generate(Algo::Cv25519, &format!("Test <{email}>"), None, pw).expect("generate")
    }

    #[test]
    fn generated_key_has_info_and_roundtrips_through_armor() {
        let sk = mkkey("a@example.com", "pw-one-2-three");
        assert!(is_protected(&sk));
        let pk = sk.to_public_key();
        let i = info(&pk, true);
        assert_eq!(i.fingerprint.len(), 40);
        assert_eq!(i.key_id, i.fingerprint[24..]);
        assert_eq!(i.user_ids, vec!["Test <a@example.com>".to_string()]);
        assert_eq!(i.algo, "Ed25519 / Curve25519");
        assert!(i.expires.is_none() && !i.expired && !i.revoked);
        let again = parse_public(&armor_public(&pk).unwrap()).unwrap();
        assert_eq!(fingerprint(&again), i.fingerprint);
        let sec = parse_secret(&armor_secret(&sk).unwrap()).unwrap();
        assert!(is_protected(&sec), "exported secret key stays protected");
        assert_eq!(emails_of(&i.user_ids), vec!["a@example.com".to_string()]);
    }

    #[test]
    fn key_with_expiry_reports_it_and_cannot_be_used_after() {
        // generation can take seconds on a loaded machine, so bracket it between two clock reads
        let before = now();
        let sk = generate(Algo::Cv25519, "E <e@example.com>", Some(30), "secret-pass").unwrap();
        let after = now();
        let pk = sk.to_public_key();
        pk.verify_bindings().expect("re-signed bindings are valid");
        let i = info(&pk, true);
        let exp = i.expires.expect("has expiry");
        // expiry = creation time + 30 days, creation time lies between the two reads (1 s rounding slack each side)
        assert!(exp >= before + 30 * 86400 - 1 && exp <= after + 30 * 86400 + 1, "expiry {exp} outside [{before}, {after}] + 30 d");
        assert!(encryption_key(&pk, now()).is_ok());
        assert_eq!(encryption_key(&pk, exp + 10).err(), Some(Unusable::Expired(exp)));
        // extend: expiry moves, key still valid
        let mut sk2 = sk.clone();
        set_expiry(&mut sk2, "secret-pass", Some(365)).unwrap();
        assert!(info(&sk2.to_public_key(), true).expires.unwrap() > exp + 300 * 86400);
        set_expiry(&mut sk2, "secret-pass", None).unwrap();
        assert!(info(&sk2.to_public_key(), true).expires.is_none());
        assert!(set_expiry(&mut sk.clone(), "wrong", Some(5)).unwrap_err().starts_with("PGP_BAD_PASSPHRASE"));
    }

    #[test]
    fn passphrase_handling() {
        let sk = mkkey("p@example.com", "right-pass-1");
        assert!(unlock_clone(&sk, "wrong").unwrap_err().starts_with("PGP_BAD_PASSPHRASE"));
        let open = unlock_clone(&sk, "right-pass-1").expect("unlocks");
        assert!(!is_protected(&open));
        let changed = change_passphrase(&sk, "right-pass-1", "new-pass-2").unwrap();
        assert!(is_protected(&changed));
        assert!(unlock_clone(&changed, "right-pass-1").is_err());
        assert!(unlock_clone(&changed, "new-pass-2").is_ok());
        assert!(change_passphrase(&sk, "nope", "x").is_err());
    }

    #[test]
    fn encrypt_decrypt_roundtrip_and_wrong_key() {
        let alice = unlock_clone(&mkkey("alice@example.com", "a-pass-1234"), "a-pass-1234").unwrap();
        let bob = unlock_clone(&mkkey("bob@example.com", "b-pass-1234"), "b-pass-1234").unwrap();
        let eve = unlock_clone(&mkkey("eve@example.com", "e-pass-1234"), "e-pass-1234").unwrap();
        let (apk, bpk) = (alice.to_public_key(), bob.to_public_key());
        let plain = b"Content-Type: text/plain\r\n\r\nhello secret\r\n";
        let armored = encrypt(plain, &[Recipient { key: &apk, hidden: false }, Recipient { key: &bpk, hidden: false }], None).unwrap();
        assert!(armored.starts_with("-----BEGIN PGP MESSAGE-----"));
        assert!(!armored.contains("hello secret"));
        for sk in [&alice, &bob] {
            let d = decrypt(armored.as_bytes(), &[sk], &[]).expect("recipient decrypts");
            assert_eq!(d.data, plain);
            assert!(d.signatures.is_empty());
        }
        assert!(matches!(decrypt(armored.as_bytes(), &[&eve], &[]), Err(DecryptError::NoKey)));
        let ids = encrypted_for(armored.as_bytes()).unwrap();
        assert_eq!(ids.len(), 2);
        assert!(ids.contains(&all_key_ids(&bpk)[1]), "lists the encryption subkey id");
    }

    #[test]
    fn hidden_recipient_still_decrypts() {
        let bob = unlock_clone(&mkkey("bob@example.com", "b-pass-1234"), "b-pass-1234").unwrap();
        let bpk = bob.to_public_key();
        let armored = encrypt(b"x", &[Recipient { key: &bpk, hidden: true }], None).unwrap();
        assert_eq!(encrypted_for(armored.as_bytes()).unwrap(), vec![String::new()]);
        assert_eq!(decrypt(armored.as_bytes(), &[&bob], &[]).unwrap().data, b"x");
    }

    #[test]
    fn sign_and_encrypt_verifies_inside() {
        let alice_locked = mkkey("alice@example.com", "a-pass-1234");
        let alice = unlock_clone(&alice_locked, "a-pass-1234").unwrap();
        let bob = unlock_clone(&mkkey("bob@example.com", "b-pass-1234"), "b-pass-1234").unwrap();
        let bpk = bob.to_public_key();
        let armored = encrypt(b"signed body", &[Recipient { key: &bpk, hidden: false }], Some((&alice, ""))).unwrap();
        let apk = alice.to_public_key();
        let d = decrypt(armored.as_bytes(), &[&bob], std::slice::from_ref(&apk)).unwrap();
        assert_eq!(d.data, b"signed body");
        assert_eq!(d.signatures.len(), 1);
        assert_eq!(d.signatures[0].status, "valid");
        assert_eq!(d.signatures[0].fingerprint.as_deref(), Some(fingerprint(&apk).as_str()));
        // without the signer's key it is reported as unknown, not as invalid
        let d = decrypt(armored.as_bytes(), &[&bob], &[]).unwrap();
        assert_eq!(d.signatures[0].status, "unknown_key");
        assert_eq!(d.signatures[0].key_id, info(&apk, false).key_id);
        // signing with a still-locked key and the right passphrase also works
        let armored = encrypt(b"x", &[Recipient { key: &bpk, hidden: false }], Some((&alice_locked, "a-pass-1234"))).unwrap();
        assert_eq!(decrypt(armored.as_bytes(), &[&bob], &[apk]).unwrap().signatures[0].status, "valid");
        assert!(encrypt(b"x", &[Recipient { key: &bpk, hidden: false }], Some((&alice_locked, "wrong"))).is_err());
    }

    #[test]
    fn detached_signature_verifies_and_detects_tampering() {
        let alice = unlock_clone(&mkkey("alice@example.com", "a-pass-1234"), "a-pass-1234").unwrap();
        let apk = alice.to_public_key();
        let data = b"Content-Type: text/plain\r\n\r\nline one\r\nline two";
        let (sig, mic) = sign_detached(&alice, "", data).unwrap();
        assert!(sig.starts_with("-----BEGIN PGP SIGNATURE-----"));
        assert_eq!(mic, "pgp-sha256");
        let keys = vec![apk.clone()];
        let ok = verify_detached(sig.as_bytes(), data, &keys);
        assert_eq!(ok.status, "valid");
        assert!(ok.signed_at.is_some());
        let tampered = verify_detached(sig.as_bytes(), b"Content-Type: text/plain\r\n\r\nline one\r\nline TWO", &keys);
        assert_eq!(tampered.status, "invalid");
        assert_eq!(tampered.fingerprint.as_deref(), Some(fingerprint(&apk).as_str()));
        let stranger = unlock_clone(&mkkey("s@example.com", "s-pass-1234"), "s-pass-1234").unwrap().to_public_key();
        let u = verify_detached(sig.as_bytes(), data, &[stranger]);
        assert_eq!(u.status, "unknown_key");
        // LF vs CRLF is not a change for a text signature
        assert_eq!(verify_detached(sig.as_bytes(), b"Content-Type: text/plain\n\nline one\nline two", &keys).status, "valid");
        // garbage signature
        assert_eq!(verify_detached(b"nope", data, &keys).status, "invalid");
    }

    #[test]
    fn rsa_key_roundtrip() {
        let sk = generate(Algo::Rsa3072, "R <r@example.com>", None, "rsa-pass-123").unwrap();
        let pk = sk.to_public_key();
        assert_eq!(info(&pk, true).algo, "RSA 3072");
        let open = unlock_clone(&sk, "rsa-pass-123").unwrap();
        let armored = encrypt(b"rsa works", &[Recipient { key: &pk, hidden: false }], Some((&open, ""))).unwrap();
        let d = decrypt(armored.as_bytes(), &[&open], &[pk]).unwrap();
        assert_eq!(d.data, b"rsa works");
        assert_eq!(d.signatures[0].status, "valid");
    }

    #[test]
    fn micalg_names_follow_rfc_3156_and_unknown_hashes_are_refused() {
        assert_eq!(micalg(HashAlgorithm::Sha256).unwrap(), "pgp-sha256");
        assert_eq!(micalg(HashAlgorithm::Sha512).unwrap(), "pgp-sha512");
        assert_eq!(micalg(HashAlgorithm::Sha1).unwrap(), "pgp-sha1");
        assert!(micalg(HashAlgorithm::Sha3_256).is_err());
    }

    #[test]
    fn import_parsing_accepts_many_and_rejects_junk() {
        let a = mkkey("a@example.com", "x-pass-12345");
        let b = mkkey("b@example.com", "y-pass-12345");
        let text = format!("{}\n{}\n{}", armor_public(&a.to_public_key()).unwrap(), armor_public(&b.to_public_key()).unwrap(), armor_secret(&a).unwrap());
        let m = parse_material(text.as_bytes()).unwrap();
        assert_eq!(m.len(), 3);
        assert_eq!(m.iter().filter(|x| x.is_secret()).count(), 1);
        assert!(parse_material(b"hello").is_err());
        assert!(parse_material(b"-----BEGIN PGP PUBLIC KEY BLOCK-----\n\nAAAA\n-----END PGP PUBLIC KEY BLOCK-----").is_err());
        // binary form
        let mut bin = vec![];
        a.to_public_key().to_writer(&mut bin).unwrap();
        let m = parse_material(&bin).unwrap();
        assert!(matches!(m[0], Material::Public(_)));
    }

    #[test]
    fn unusable_certificates_are_reported() {
        let sk = mkkey("a@example.com", "x-pass-12345");
        let mut pk = sk.to_public_key();
        assert!(encryption_key(&pk, now()).is_ok());
        // strip the encryption subkey: nothing to encrypt to
        pk.public_subkeys.clear();
        assert_eq!(encryption_key(&pk, now()).err(), Some(Unusable::NoEncryptionKey));
        assert!(encrypt(b"x", &[Recipient { key: &pk, hidden: false }], None).unwrap_err().contains("no encryption key"));
        assert!(encrypt(b"x", &[], None).is_err());
    }

    // ---- interop with a real GnuPG, when one is on PATH ----

    /// The MSYS/Cygwin builds of GnuPG found on Windows want /c/Users/... paths.
    fn gp(p: &std::path::Path) -> String {
        let s = p.to_string_lossy().replace('\\', "/");
        match s.as_bytes() {
            [d, b':', ..] if cfg!(windows) && d.is_ascii_alphabetic() => format!("/{}{}", (*d as char).to_ascii_lowercase(), &s[2..]),
            _ => s,
        }
    }

    fn gpg(home: &std::path::Path, args: &[&str], input: Option<&[u8]>) -> Option<std::process::Output> {
        use std::io::Write;
        use std::process::{Command, Stdio};
        let mut cmd = Command::new("gpg");
        cmd.arg("--homedir").arg(gp(home)).args(["--batch", "--yes", "--no-tty", "--pinentry-mode", "loopback", "--passphrase", "", "--trust-model", "always"]).args(args);
        cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
        let mut child = cmd.spawn().ok()?;
        if let Some(i) = input {
            child.stdin.take()?.write_all(i).ok()?;
        } else {
            drop(child.stdin.take());
        }
        child.wait_with_output().ok()
    }

    #[test]
    fn interop_with_gnupg_if_installed() {
        let dir = std::env::temp_dir().join(format!("heylook-gpg-{}", now()));
        std::fs::create_dir_all(&dir).unwrap();
        let ver = gpg(&dir, &["--version"], None);
        if !ver.as_ref().is_some_and(|o| o.status.success()) {
            eprintln!("gpg not found: interop test skipped");
            return;
        }
        let ok = |o: Option<std::process::Output>, what: &str| {
            let o = o.unwrap_or_else(|| panic!("{what}: could not run gpg"));
            assert!(o.status.success(), "{what} failed: {}", String::from_utf8_lossy(&o.stderr));
            o
        };
        ok(gpg(&dir, &["--quick-generate-key", "Gpg User <gpg@example.com>", "ed25519", "cert,sign", "never"], None), "gpg keygen");
        let fpr_out = ok(gpg(&dir, &["--with-colons", "--list-keys", "gpg@example.com"], None), "list");
        let fpr = String::from_utf8_lossy(&fpr_out.stdout).lines().find(|l| l.starts_with("fpr:")).unwrap().split(':').nth(9).unwrap().to_string();
        ok(gpg(&dir, &["--quick-add-key", &fpr, "cv25519", "encr", "never"], None), "gpg add encryption subkey");
        let gpg_pub = String::from_utf8(ok(gpg(&dir, &["--armor", "--export", "gpg@example.com"], None), "export").stdout).unwrap();

        // our key
        let mine = mkkey("me@example.com", "my-pass-1234");
        let mine_open = unlock_clone(&mine, "my-pass-1234").unwrap();
        let mine_pub = mine.to_public_key();
        let their_pub = parse_material(gpg_pub.as_bytes()).unwrap().remove(0).public();
        assert_eq!(fingerprint(&their_pub), fpr, "we read GnuPG's key identically");
        assert!(encryption_key(&their_pub, now()).is_ok());
        ok(gpg(&dir, &["--import"], Some(armor_public(&mine_pub).unwrap().as_bytes())), "gpg imports our key (self-signatures are valid)");

        // we encrypt + sign, gpg decrypts and verifies
        let plain = b"Content-Type: text/plain

hello from heylook
";
        let armored = encrypt(plain, &[Recipient { key: &their_pub, hidden: false }], Some((&mine_open, ""))).unwrap();
        let out = ok(gpg(&dir, &["--decrypt"], Some(armored.as_bytes())), "gpg decrypt");
        assert_eq!(out.stdout, plain);
        assert!(String::from_utf8_lossy(&out.stderr).contains("Good signature"), "{}", String::from_utf8_lossy(&out.stderr));

        // gpg encrypts + signs to us, we decrypt and verify
        std::fs::write(dir.join("in.txt"), plain).unwrap();
        let sec = String::from_utf8(ok(gpg(&dir, &["--armor", "--encrypt", "--sign", "--local-user", &fpr, "--recipient", "me@example.com", "--output", "-", &gp(&dir.join("in.txt"))], None), "gpg encrypt").stdout).unwrap();
        assert!(sec.starts_with("-----BEGIN PGP MESSAGE-----"));
        let d = decrypt(sec.as_bytes(), &[&mine_open], std::slice::from_ref(&their_pub)).expect("we read GnuPG's message");
        assert_eq!(d.data, plain);
        assert_eq!(d.signatures.len(), 1);
        assert_eq!(d.signatures[0].status, "valid", "{:?}", d.signatures);

        // detached signatures both ways
        let data = b"Content-Type: text/plain

signed by us
";
        let (sig, _) = sign_detached(&mine_open, "", data).unwrap();
        std::fs::write(dir.join("sig.asc"), &sig).unwrap();
        std::fs::write(dir.join("data.txt"), data).unwrap();
        let v = ok(gpg(&dir, &["--verify", &gp(&dir.join("sig.asc")), &gp(&dir.join("data.txt"))], None), "gpg verifies our detached signature");
        assert!(String::from_utf8_lossy(&v.stderr).contains("Good signature"));
        let gsig = ok(gpg(&dir, &["--armor", "--detach-sign", "--textmode", "--local-user", &fpr, "--output", "-", &gp(&dir.join("data.txt"))], None), "gpg detach-sign").stdout;
        assert_eq!(verify_detached(&gsig, data, std::slice::from_ref(&their_pub)).status, "valid");

        let _ = gpg(&dir, &["--kill", "all"], None);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
