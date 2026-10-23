# Linux stores: Snap Store, AppImageHub and the APT repository

The release workflow builds the AppImage, `.deb` and `.rpm` and attaches them to the GitHub Release (see
[CONTRIBUTING.md](CONTRIBUTING.md#releasing)). This page is about the two Linux catalogues beside that, what is automated and
what is done by hand.

| Where | Package | Built by | Published by |
|---|---|---|---|
| Snap Store (Ubuntu App Center, `snap install hey-look`) | `snap/snapcraft.yaml` | `linux-stores.yml` on every tag | the workflow, to the `candidate` channel; `stable` by hand |
| AppImageHub (appimage.github.io) | the release AppImage | `release.yml` | one-time listing; it follows the GitHub releases |

Shared by both and by the `.deb` / `.rpm`: the AppStream file `linux/io.github.thnonl.HeyLook.metainfo.xml` (name, summary,
description, screenshot, releases; the texts are translated per element with `xml:lang`, and every change to them goes through the
language specialists like the app's own strings). **Every release adds its `<release>` as the FIRST entry** in the version-bump
commit (a ready block for the next version sits in a comment above the list): `verify-version.cjs` fails the tag run and
`linux-stores.yml` fails a pull request when the first entry is not the version in `package.json`. The snap takes its version and
texts from it, the software centres show it. The screenshot is a plain 1280 x 800 PNG of the Inbox on Linux (English, light theme,
demo data), `docs/media/linux-inbox-1280.png` on the website; the caption describes it, so a new screenshot means a new caption
through the specialists.

A copy installed from the Snap Store is updated by the store: `update::managed_by` (Rust) sees `SNAP_NAME`, every update
check answers `managed`, Settings > About says the Snap Store updates the app and shows neither the "Check for updates" button
nor the automatic-check switch. A `.deb` with the Hey Look! APT repository (below) is managed the same way; the AppImage, `.rpm` and a `.deb` without the
repository keep the in-app updater.

## APT repository (Debian and Ubuntu)

The `.deb` is also published in a signed APT repository at `https://heylook.namthai.site/apt`, so people on Debian 12 or later and Ubuntu 22.04 or later
install and update Hey Look! with `apt` and the desktop's software updater. The repository holds the same `.deb` as the GitHub release (nothing is
rebuilt), for `amd64` only, in one suite `stable`, component `main`. Not the Debian/Ubuntu archive and not a PPA (a PPA takes source packages and
builds them without network access, which this app cannot do).

**What users run** (the download page, `docs/apt/heylook.sources`):

```
sudo wget -qO /etc/apt/keyrings/heylook-archive-keyring.gpg https://heylook.namthai.site/apt/heylook-archive-keyring.gpg
sudo wget -qO /etc/apt/sources.list.d/heylook.sources https://heylook.namthai.site/apt/heylook.sources
sudo apt update && sudo apt install hey-look
```

The key is used for this repository only (`Signed-By` in the sources file); there is no `apt-key` and nothing in `trusted.gpg.d`. The same source as
one line, for administrators (not on the website):
`deb [arch=amd64 signed-by=/etc/apt/keyrings/heylook-archive-keyring.gpg] https://heylook.namthai.site/apt stable main`.
Remove: `sudo apt remove hey-look && sudo rm /etc/apt/sources.list.d/heylook.sources /etc/apt/keyrings/heylook-archive-keyring.gpg`.

**How it is made.** Everything runs in `release.yml` (job `apt-repo`, tag runs only, after `publish`) and `pages.yml`:

1. `.github/scripts/apt-repo.sh fetch` lists the newest 3 published releases (tag `vX.Y.Z`, not a draft, not a pre-release, with the asset
   `HeyLook_<version>_linux_amd64.deb`), downloads each `.deb` and checks its sha256 against the `digest` GitHub shows for the asset. A version that
   is already in the previous `pool.json` with another sha256 fails the job naming the version: a published file never changes.
2. `apt-repo.sh build` runs `apt-ftparchive` (`Packages`, `.gz`, `.xz`, `Release` with `Acquire-By-Hash: yes`, `by-hash` copies; no `Valid-Until`, so an
   idle repository never expires). `apt-repo.sh sign` signs `InRelease` and `Release.gpg` (SHA512) with the key of the Environment `release`; the
   imported key's fingerprint must be the one of `docs/apt/heylook-archive-keyring.asc`, else nothing is signed. `apt-repo.sh verify` then checks
   it the way apt does (`gpgv` with the committed public key, every hash of `Release`, every `.deb` against `Packages`).
3. `.github/scripts/apt-install-test.sh` installs from the repository (served on the runner) in `ubuntu:22.04`, `ubuntu:24.04` and `debian:12`
   (pinned by digest): the three commands above, the version, an upgrade from the previous version (Ubuntu), the remove command, and two negative
   tests (a changed byte in the index and a repository signed by another key must make `apt update` fail).
4. `apt-repo.sh publish-branch` commits `dists/` and `pool.json` (text, no `.deb`) to the orphan branch `apt` when `Packages` or `pool.json`
   changed, then the job starts `pages.yml` on `main`.
5. `pages.yml` adds `dists/`, `pool.json` and the `.deb` files (downloaded from the release assets named by `pool.json`, nowhere else) to the site,
   checks signature and hashes again with `.github/scripts/apt-assemble.sh` BEFORE it uploads anything, deploys, and `apt-live-check` waits for the
   live `InRelease`, checks the files with `curl -I` (200, no redirect, no `Content-Encoding`, the right length), downloads the newest `.deb`
   and installs it in a fresh `ubuntu:24.04` from the live address.

A dry run of `release.yml` (job `apt-repo-dryrun`) builds the same repository from the dry run's own `.deb` with a throw-away key made in the job (no
secret, no push, no Pages) and keeps it as the workflow artifact `apt-repo-dryrun` (public key included, never a private key).

**The `.deb` and the tray library.** The Linux build installs `libayatana-appindicator3-dev` (never `libappindicator3-dev`), so the `.deb` depends
on `libayatana-appindicator3-1`, which Debian 12 and Ubuntu have; `libappindicator3-1` is gone from Debian 12. The build fails when the `Depends:`
line names anything else (step "The .deb depends on the Ayatana tray library"). `.deb` files of 1.0.6 and older still name the old library, so
on Debian 12 only the newest version of the repository installs.

**A copy updated by apt does not update itself.** `update::managed_by()` returns `apt` for the `.deb` build when an enabled APT source for
`heylook.namthai.site/apt` exists in `/etc/apt/sources.list`, `sources.list.d/*.list` (a `deb` line, not commented) or `sources.list.d/*.sources`
(`Types:` has `deb`, `URIs:` has the address, no `Enabled: no`); the snap keeps priority, the AppImage and `.rpm` are never apt copies. Such a copy
makes no GitHub request, offers no download, and Settings > About says apt updates it. A `.deb` installed without the repository keeps the in-app
updater until the repository is added. A debug build can pretend: `HEYLOOK_TEST_MANAGED=apt` (or `snap`, or `none`); release builds ignore it (the
release workflow searches the built app for the name).

**Owner steps (once; the coder never sees the secret).**
1. Make the key on your own machine with GnuPG 2.2 or later, a long passphrase: `gpg --quick-generate-key "Hey Look! APT signing <namth.onl@gmail.com>" rsa4096 sign never`
   (RSA 4096, signing only, no expiry: users download the key once, an expiry date would break every install that day).
2. Note the fingerprint: `gpg --list-keys --with-colons "Hey Look! APT signing" | awk -F: '/^fpr/{print $10; exit}'`.
3. Export the public key into `docs/apt/`: `gpg --armor --export <FPR> > docs/apt/heylook-archive-keyring.asc` and
   `gpg --export <FPR> > docs/apt/heylook-archive-keyring.gpg`, and write the fingerprint (10 groups of 4) on the 8 download pages
   (`docs/*/download.html`, between `<!-- hl:apt-begin -->` and `<!-- hl:apt-end -->`; `node scripts/test-site-apt.mjs` shows what is wrong).
   Until the real key is there the directory holds a throw-away key ("Hey Look! APT test (throwaway)") and that test fails on purpose: in a tag
   run always, in other runs of `release.yml` (dry runs, branch runs) it is only a warning (DEC-020; the variable is set in one place, the
   `node-tests` job, and `scripts/test-apt-placeholder-guard.mjs` keeps it there). The website needs no key until the repository exists, see
   "The website is dormant" below.
4. Export the secret key: `gpg --armor --export-secret-keys <FPR> > apt-signing-secret.asc`. In GitHub > Settings > Environments > `release`
   add the Environment secrets `APT_SIGNING_KEY` (the file's text) and `APT_SIGNING_PASSPHRASE`. Then `shred -u apt-signing-secret.asc`.
5. Backup (mandatory): the secret key export, the passphrase and the revocation certificate GnuPG wrote to `~/.gnupg/openpgp-revocs.d/<FPR>.rev`,
   on two offline media. Never in the repository, in a report folder or in a cloud drive in plain text. **A lost key means every user must run
   steps 1 and 2 of the download page again with a new key.**
6. GitHub: a ruleset for the branch `apt` (no force push, no deletion; GitHub Actions may push); check that the `github-pages` Environment allows
   `main`.
7. After the release is public: merge the release branch to `main` (the site and `pages.yml` go live from `main`) and watch `pages.yml` >
   `apt-live-check`. Then on a Debian or Ubuntu machine: `sudo apt update && apt policy hey-look`.

**The website is dormant until the repository exists (DEC-022).** The "Install with APT" block of the download pages sits between
`<!-- hl:apt-begin -->` and `<!-- hl:apt-end -->` (exactly one pair on each of the 8 download pages; no other page links to `#apt` or `/apt/`). A
Pages build has `APT_SITE=on` only when the branch `apt` exists (the first tag run with the real key makes it); nothing else can switch it on (no
input, no variable; `test-apt-placeholder-guard.mjs` keeps it so). Without the branch `scripts/build-site.mjs` takes the block out of the 8 pages
and does not copy `docs/apt/`, and `node scripts/test-site-apt.mjs --built=_site` proves that the built site has no block, marker, `apt/` folder,
link or APT text; the throw-away key is then not looked at (its files are not deployed), so site updates are never blocked by the missing key. With
the branch (`on`) the block and `docs/apt/` are deployed, `apt-assemble.sh` adds the repository, and the throw-away key FAILS the run before the
upload (`APT_ALLOW_PLACEHOLDER_KEY` is ignored in this mode). Locally `node scripts/build-site.mjs _site` is dormant (add `APT_SITE=on` to see the
block).

**Rotation.** (1) Make the new key offline. (2) Sign `InRelease` with both keys for at least 6 months (apt accepts the file when one signature
verifies with the keys of `Signed-By`). (3) The key file on the site holds both public keys and the download page tells people to run step 1
again. (4) Stop signing with the old key. **If the key is compromised:** publish the revocation, a new key, a notice on the download page and a
CHANGELOG line; users run step 1 again.

**Troubleshooting.** `NO_PUBKEY <id>` or "The repository ... is not signed": the key file in `/etc/apt/keyrings/` is missing, is not the one of the
site (`gpg --show-keys /etc/apt/keyrings/heylook-archive-keyring.gpg`, compare with the fingerprint on the download page) or the sources file
points at another key. `Hash Sum mismatch`: a cache served a half-old repository (the by-hash copies make this rare); run `sudo apt update`
again after ten minutes. `E: The repository ... does not have a Release file`: the address in `heylook.sources` is wrong. On arm64 the
repository is ignored (`Architectures: amd64`); there is no arm64 `.deb`.

## OAuth client ids

`src-tauri/build.rs` embeds `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `MICROSOFT_CLIENT_ID` and `MICROSOFT_CLIENT_SECRET`
from the build environment (or a `.env` file). Without them Gmail and Microsoft sign-in are not offered. On a tag push the
workflow builds the snap inside the GitHub Environment `release` and writes the four secrets into `.env` for the snapcraft build,
then removes the file: the same values as the release installers. A pull request or a manual run (also one started on a tag)
has no Environment, no secrets and no upload: it builds a snap without sign-in for Gmail and Microsoft, as a workflow artifact.

## Snap Store

One-time, by the account owner:

1. Create an account on https://snapcraft.io/ and register the name: `snapcraft register hey-look`.
2. Make a store login for CI, limited to this snap and to uploading:
   `snapcraft export-login --snaps=hey-look --acls=package_access,package_push,package_update,package_release --expires=2027-12-31 login.txt`
   and store the file's content as the secret `SNAPCRAFT_STORE_CREDENTIALS` **of the Environment `release`** (Settings >
   Environments > release > Environment secrets; not a repository secret, so only a tag push can read it). Renew before it expires.
3. On the store page: the icon (`src-tauri/icons/icon.png`), screenshots, the category (Productivity), the website and contact.
4. The `password-manager-service` interface is not connected automatically. Ask for an auto-connection on
   https://forum.snapcraft.io/c/store-requests (what the app stores: account passwords and OAuth tokens, in the system keyring,
   like every mail client), together with a review of the `dbus` slot `thnonl.heylook.SingleInstance` (single instance). Until the
   auto-connection is granted the snap stays in `candidate`, and the help page should tell people to run
   `sudo snap connect hey-look:password-manager-service` (new website text, eight languages, through the text rule).

Every release: the tag push uploads the snap to `candidate`, whether or not `release.yml` succeeded. Promote only after the
GitHub release is published and the auto-connection above is granted: install from `candidate`
(`snap install hey-look --candidate`), try sign-in, the tray, a notification, then `snapcraft release hey-look <revision> stable`
(the revision is in the workflow log, or `snapcraft status hey-look`). Nothing else uploads: a manual run of the workflow and a
pull request only build (the `.snap` is a workflow artifact, installable with `--dangerous`).

The build runs snapcraft in LXD on the runner (the duration is not measured yet; the first tag run tells). Locally on Ubuntu:
`sudo snap install snapcraft --classic`, `snapcraft` in the repository root, `sudo snap install --dangerous hey-look_*.snap`.

## AppImageHub

AppImageHub (https://appimage.github.io/) lists AppImages that are published on GitHub Releases; it is a catalogue, not a store,
and it reads each new release on its own once the app is listed. One-time:

1. Fork https://github.com/AppImage/appimage.github.io.
2. Add the file `data/Hey_Look` with one line, the repository address: `https://github.com/thnonl/hey-look`.
3. Open the pull request. Their check downloads the latest release AppImage and reads its desktop file, icon and AppStream
   file (`usr/share/metainfo/hey-look.appdata.xml`, put there by `bundle.linux.appimage.files` in `src-tauri/tauri.conf.json`
   from the shared metainfo). A release made before this change has no metainfo in its AppImage: open the pull request after
   the first release that ships it.

## The website

Once the snap is in `stable`, `docs/download.html` (and the seven translations, see CONTRIBUTING.md > Website languages) should
offer `snap install hey-look` and the Snap Store badge beside the AppImage, `.deb` and `.rpm` links, and `docs/help.html` the
`snap connect` line until the auto-connection is granted.
