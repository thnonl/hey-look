# Stores and package repositories: Snap Store, AppImageHub, the APT repository and the Microsoft Store

The release workflow builds the AppImage, `.deb` and `.rpm` and attaches them to the GitHub Release (see
[CONTRIBUTING.md](CONTRIBUTING.md#releasing)). This page is about the Linux catalogues beside that, what is automated and
what is done by hand; the last chapter, [Microsoft Store](#microsoft-store-windows), is about Windows.

| Where | Package | Built by | Published by |
|---|---|---|---|
| Snap Store (Ubuntu App Center, `snap install hey-look`) | `snap/snapcraft.yaml` | `linux-stores.yml` on every tag | the workflow, to the `candidate` channel, only with the repository variable `SNAP_PUBLISH` = `true` (off); `stable` by hand |
| AppImageHub (appimage.github.io) | the release AppImage | `release.yml` | one-time listing; it follows the GitHub releases |

**What a tag run publishes (DEC-028).** Release 1.0.7 is published on GitHub only (installers for Windows, macOS and Linux, `latest.json` for the in-app updater). The APT
repository, the Snap Store upload and the Microsoft Store are **off**, and a tag run is green without them: no job waits for a key, a store login or a Partner Center step.
Each channel has a repository variable (Settings > Secrets and variables > Actions > Variables), exactly the value `true` switches it on, unset or anything else leaves it off:

| Variable | Switches on | Needs (only then) | Read by |
|---|---|---|---|
| `APT_PUBLISH` | the job `apt-repo` (signed APT repository, branch `apt`, site rebuild) on a tag run, and the strict check of the APT signing key in `node-tests` | the real key in `docs/apt` and the secrets `APT_SIGNING_KEY`, `APT_SIGNING_PASSPHRASE` of the Environment `release` | the plan job of `release.yml` (output `apt_publish`) |
| `SNAP_PUBLISH` | the upload of the snap to `candidate` on a tag run (the snap is built either way) | the secret `SNAPCRAFT_STORE_CREDENTIALS` of the Environment `release` (section Snap Store) | `linux-stores.yml` |
| `STORE_SUBMIT` | the job `store-submit` (Partner Center), see Microsoft Store | the Environment `store` and its secrets | the plan job |
| `STORE_EXE` | the offline installer for the Store (`store-exe`, `store-url`), see Microsoft Store | a signed installer | the plan job, `pages.yml` |

Without `APT_PUBLISH` the website is dormant (no "Install with APT" block, no `apt/` folder: see "The website is dormant" below), the throw-away key of `docs/apt` is
reported as a notice by `scripts/test-site-apt.mjs` instead of failing the run (`scripts/test-apt-placeholder-guard.mjs` proves that a run that does publish the repository
is still strict), and the `apt-repo-dryrun`, `msix` and `msix-check` jobs stay as checks that cannot hold back `publish`. To publish the APT repository in a later release:
do the owner steps below, then set `APT_PUBLISH` = `true` before the tag.

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

**Off in release 1.0.7: this chapter describes what runs when the repository variable `APT_PUBLISH` is `true`.** The `.deb` is then also published in a signed APT repository at `https://heylook.namthai.site/apt`, so people on Debian 12 or later and Ubuntu 22.04 or later
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
   Until the real key is there the directory holds a throw-away key ("Hey Look! APT test (throwaway)") and that test fails on purpose in a tag
   run with `APT_PUBLISH` = `true`; in every other run of `release.yml` (dry runs, branch runs, the tag run of a release without APT) it is only a notice (DEC-020, DEC-028; the variable
   `APT_ALLOW_PLACEHOLDER_KEY` is set in one place, the `node-tests` job, from the plan output `apt_publish`, and `scripts/test-apt-placeholder-guard.mjs` keeps it there). The website needs no key until the repository exists, see
   "The website is dormant" below.
4. Export the secret key: `gpg --armor --export-secret-keys <FPR> > apt-signing-secret.asc`. In GitHub > Settings > Environments > `release`
   add the Environment secrets `APT_SIGNING_KEY` (the file's text) and `APT_SIGNING_PASSPHRASE`. Then `shred -u apt-signing-secret.asc`.
5. Backup (mandatory): the secret key export, the passphrase and the revocation certificate GnuPG wrote to `~/.gnupg/openpgp-revocs.d/<FPR>.rev`,
   on two offline media. Never in the repository, in a report folder or in a cloud drive in plain text. **A lost key means every user must run
   steps 1 and 2 of the download page again with a new key.**
6. GitHub: a ruleset for the branch `apt` (no force push, no deletion; GitHub Actions may push); check that the `github-pages` Environment allows
   `main`.
7. Set the repository variable `APT_PUBLISH` to `true` before the tag (without it the job `apt-repo` is skipped).
8. After the release is public: merge the release branch to `main` (the site and `pages.yml` go live from `main`) and watch `pages.yml` >
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

Every release with the repository variable `SNAP_PUBLISH` = `true` (off by default, DEC-028; the upload step is skipped otherwise and the tag run does not need the store login): the tag push uploads the snap to `candidate`, whether or not `release.yml` succeeded. Promote only after the
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

## Microsoft Store (Windows)

Hey Look! goes to the Microsoft Store as an **MSIX package** (option A of the plan; the Store signs it itself, hosts it and updates it, so it needs no
certificate and no hosting of ours). An EXE installer for the Store (option B) is built too, but switched off (last section of this chapter).
The release workflow makes and checks the package on every Windows build; **what is submitted and when is the owner's decision**: nothing here
publishes, and nothing reads a store credential, unless a repository variable (below) says so. **Release 1.0.7 is not submitted to the Store** (DEC-028): the job `msix` and `msix-check` run as checks only,
the website's Store block stays hidden (`STORE_PRODUCT_ID` in `docs/assets/site.js` is empty) and the help page says the app is not in the Store yet.

**The app in the package (packaged mode, `src-tauri/src/pkg.rs`).** The same `hey-look.exe` notices that it has a package identity (`GetCurrentPackageFullName`) and then
- keeps its data in the package's own folder `%LOCALAPPDATA%\Packages\<family>\LocalState` (a Tauri directories override, so the main window, the gated start and every pop-out take the same folders), the web view's data in
  `...\LocalCache` and the files that "Open" hands to other programs in `...\TempState\HeyLook`; it never touches `%APPDATA%\thnonl.heylook` (a GitHub install on the same PC keeps its data, nothing is migrated);
- keeps its passwords and tokens under the credential store service `heylook.store` (a GitHub install uses `heylook`), and does not migrate the entries of the oldest service names;
- shows its toasts under the package's own AppUserModelID and writes nothing to the registry for them;
- does not update itself: `update::managed_by` answers "msstore", every check answers "managed", the download and install commands refuse; Settings > About shows "Updates come from the Microsoft Store." and the Store form of the
  privacy text, without the "Check for updates" button and the switch;
- starts at sign-in through the package's startup task `HeyLookStartup` (off until the person turns it on; the person can turn it off in Windows Settings > Apps > Startup, an organisation can decide: the switch is then grey
  with a hint); a start by the task behaves like `--minimized` (tray only, when there is a tray).

Not done in the package: single instance is the plugin's (it keys on the app identifier, so a GitHub copy and a Store copy running together hand a second start to the first: use one of them), and a notification that
is clicked after the app was closed does not start it (as in the GitHub version). `appPackagedMode` in `src-tauri/msix/readiness.json` is `true`; the job `msix-check` then requires the database in `LocalState` on the runner,
so the first dry run shows whether the packaged mode really works in a package. **Never tested yet in a real package** (the packaged paths, the startup task and the activation kind need a package, which the owner's PC and
the developers' PCs must not install): the CI job `msix-check`, the owner's smoke list and QA rows M-7 to M-11 do that. If `msix-check` fails, set `appPackagedMode` back to `false` until the cause is fixed.
QA without a package (debug builds only): `HEYLOOK_SIMULATE_PACKAGED=1` shows the Store texts (the updater logic and the UI), `HEYLOOK_SIMULATE_AUTOSTART_LOCK=user|policy` forces the grey autostart switch; they never change a path, the credential store or the
system. In the dev preview of the page: `#managed=msstore` and `#autostartlock=user|policy`.

| File | What it is |
|---|---|
| `src-tauri/msix/AppxManifest.xml.in` | the manifest: identity from the variables below, version from `tauri.conf.json` (`1.0.7` becomes `1.0.7.0`), x64, Windows 10 1809 or later, the restricted capability `runFullTrust` and nothing else, the startup task `HeyLookStartup` (off), the 8 languages, `UpdateWhileInUse=defer` |
| `src-tauri/msix/readiness.json` | `appPackagedMode`: does the app have its packaged mode (see above) |
| `scripts/msix-build.mjs` | builds the package from the release exe with the Windows SDK (`makeappx`, `makepri`), and a copy signed with a throw-away certificate |
| `scripts/msix-assets.mjs` | draws the package logos and the Store listing images from `docs/assets/favicon.svg` (headless Chrome or Edge); the PNGs are not committed |
| `scripts/msix-verify.mjs` | unpacks a package and checks it against the manifest rules, the images and the exe |
| `.github/scripts/msix-check.ps1` | installs the test-signed copy on the disposable runner, starts it, checks it, removes it |

**Name and identity.** The Store shows **Hey Look! Mail Client**, the only name that was reserved for the product ("Hey Look!" was not available), and the
manifest carries exactly that name (`DisplayName`, Partner Center refuses any other). Inside the app, on the website and in the tray the app stays "Hey Look!".
The three identity values come from Partner Center > Product management > Product identity; they are public, not secrets. The workflow carries the current values as defaults (and a test pins them), and the repository variables
(Settings > Secrets and variables > Actions > Variables) override them. The current product has:

| Variable | Partner Center field | Value |
|---|---|---|
| `MSIX_IDENTITY_NAME` | `Package/Identity/Name` | `40278Noamo.651773BC9C4C7` |
| `MSIX_PUBLISHER` | `Package/Identity/Publisher` | `CN=FE739770-637C-437D-B2B9-DAA2E2EA56F1` |
| `MSIX_PUBLISHER_DISPLAY_NAME` | `Package/Properties/PublisherDisplayName` | `Noamo` |

```
gh variable set MSIX_IDENTITY_NAME --body 40278Noamo.651773BC9C4C7
gh variable set MSIX_PUBLISHER --body CN=FE739770-637C-437D-B2B9-DAA2E2EA56F1
gh variable set MSIX_PUBLISHER_DISPLAY_NAME --body Noamo
```

Compare them with the Product identity page once more before the first submission: Partner Center refuses a package whose values differ in a single character. The
Store shows the publisher name `Noamo` (the display name of the Partner Center account); if you prefer another one, change it in the account settings first and set the variable
to the new value. Setting the variables is only needed when a value changes (a variable overrides the default); a variable that is only partly set mixes with the defaults, so set all three together. The placeholder identity
(`CN=HeyLook-Dev`) exists only for a local build without the values (`scripts/msix-build.mjs` run by hand); a dry run's package is never called `msix-store`.

**What a run produces** (Actions > the run > Artifacts; the summary of the job `msix` lists version, identity, sizes and the sha256 of `hey-look.exe`, which is the file of the Windows build, byte for byte).

| Artifact | When | Contents |
|---|---|---|
| `msix-store` / `msix-store-NOT-READY` | tag runs, 14 days | `HeyLook_<V>_x64.msix`, **unsigned**: what you upload to Partner Center. Never attached to the GitHub release (users cannot install an unsigned MSIX) |
| `msix-store-logos` | every run, 14 days on a tag, else 1 | box art 2160 x 2160 and 1080 x 1080, poster 1440 x 2160 and 720 x 1080, app tile 300 x 300 (Partner Center > Store listing) |
| `msix-test` | every run, 1 day | `HeyLook_<V>_x64_test.msix` signed with a throw-away certificate whose subject is the Publisher (its key is deleted at once) and `HeyLook-test.cer`, its public half; for `msix-check` and, if you enable Windows Sandbox, for a look inside the Sandbox |
| `msix-wack-report` | when the runner has the Windows App Certification Kit | the report; its FAIL lines are in the summary of `msix-check` (information, not a gate: the Store runs its own checks) |

The job `msix-check` (every Windows run) trusts the throw-away certificate in the machine store of the runner (a virtual machine that is thrown away), installs the
test-signed copy, starts it the way the Start menu does, waits 30 seconds, checks that `hey-look.exe` runs from `WindowsApps` and is still alive, that `%APPDATA%\thnonl.heylook`
does not exist (and, once the app has its packaged mode, that the database is in `%LOCALAPPDATA%\Packages\<PFN>\LocalState`), removes the package and checks that its folder is gone.
**Never install the test-signed package on a PC you keep:** trusting the certificate is a security setting. Not run yet: the first dry run
(`gh workflow run release.yml --ref <branch> -f platforms=windows`) shows whether the activation and the removal work on the runner image (the script is written from Microsoft's documentation).

**Owner steps.**
1. Partner Center > Apps and games: the product is of the type "MSIX or PWA app" with the reserved name `Hey Look! Mail Client` (a reservation not used within 3 months is released).
2. Nothing to set for the identity (defaults above; compare them with the Product identity page). Optional now, needed for the automation: a known user group (Partner Center > Customers) with the personal Microsoft accounts of the testers.
3. After the tag run (and after WP14 part 2): download `msix-store` from the run. Partner Center > new submission: Pricing and availability (all markets, **private audience** first, free), Properties
   (Productivity; privacy policy `https://heylook.namthai.site/privacy.html`; generative AI: yes), Age ratings, Packages (upload the `.msix`; Partner Center takes an unsigned
   package; if it refuses one, upload the `msix-test` copy instead, the Store replaces the signature, and tell the coder), the Store listings of the 8 languages (texts and screenshots prepared by the BA/QA; the
   images of `msix-store-logos`), Submission options (the notes for certification and the justification below) > Submit.
4. After certification install from the private link with the Microsoft account of the audience and run the smoke list (sign in, read, send, an attachment, autostart, uninstall).
5. A second submission switches the audience to **Public** (it cannot go back to private).
6. Every release: upload the new `msix-store` (or approve `store-submit`), paste "What's new" in the 8 languages.

Justification for the restricted capability `runFullTrust` (Submission options):
```
runFullTrust: Hey Look! is a desktop email client built with Tauri (Rust + Microsoft Edge WebView2). It is a classic Win32 desktop app packaged with MSIX (Desktop Bridge) and needs full trust to run its own process: it connects to the user's mail servers over IMAP/SMTP with TLS, keeps its mail cache in a local SQLite database in the package's LocalState folder, stores passwords and OAuth tokens in Windows Credential Manager, receives the OAuth sign-in redirect on a 127.0.0.1 loopback port, shows its window through WebView2, shows a notification-area (tray) icon and Windows notifications, and opens links and attachments with the user's default apps. It installs no drivers or services and does not elevate.
```

**Good to know.** The Store version keeps its own data, apart from a copy installed from GitHub (no migration; the help page says "use one of them on a computer"); saved passwords stay in Windows
Credential Manager after an uninstall (Windows does not remove them). The package declares no `mailto:` handler, protocol or file type. A Store update of a running tray app is applied when the
app quits, or by Windows 11 24H2 and later without closing it (`UpdateWhileInUse`); the first update after the first release is a smoke row. The Microsoft Edge WebView2 Runtime comes with Windows 11 and
most Windows 10 PCs; where it is missing the app's own start-fail dialog says so.

**Try it on your computer without installing anything.** `node scripts/msix-build.mjs --exe <a hey-look.exe> --out <new folder> --test-sign --store-logos` (Windows SDK, OpenSSL and Chrome or Edge needed) builds and
signs a package, `node scripts/msix-verify.mjs <folder>\HeyLook_<V>_x64.msix --from <folder>\msix-build.json --exe <a hey-look.exe>` checks it; `node scripts/test-msix-build.mjs` does both with a stand-in program.

### Submitting by workflow (off)

The job `store-submit` sends the package to Partner Center by itself. It runs only on a tag run with the repository variable `STORE_SUBMIT` = `true`, only after `publish`,
`msix` and `msix-check` succeeded, and only for a package whose app has its packaged mode. It needs the Environment **`store`** (Settings > Environments > New environment; add yourself as *required
reviewer*, so every submission waits for your approval), whose secrets are `AZURE_AD_TENANT_ID`, `AZURE_AD_APPLICATION_CLIENT_ID`, `AZURE_AD_APPLICATION_SECRET` and `SELLER_ID` (an Entra ID
application with the Manager role in Partner Center, Microsoft's "Store Developer CLI" setup: Partner Center > Account settings > Tenants and users), and the variable `STORE_PRODUCT_ID`
(the Store ID of the product, 12 characters). Microsoft allows the CLI only for updates: **the first submission is made by hand** (steps above). Type the secrets yourself
(`gh secret set --env store ...`); never paste them anywhere else. Without `STORE_SUBMIT` the job does not exist in the run, nothing waits for approval and no secret is read.
The steps (`microsoft/microsoft-store-apppublisher`, `msstore reconfigure`, `msstore publish ... --inputFile ... --appId`) are written from Microsoft's documentation and have **never run**.

### Option B: the EXE installer for the Store (off)

Only if a trigger happens (Partner Center cannot keep the MSIX product, certification refuses the MSIX twice for something we cannot fix, the private audience finds a blocker, or you decide so). The repository variable
`STORE_EXE` = `true` turns on, exactly with that value:

- the job `store-exe` builds a second NSIS installer with the WebView2 Runtime inside (about 135 MB, `src-tauri/tauri.store-exe.conf.json`), named `HeyLook_<V>_windows_x64_offline.exe`, and attaches it to the draft release (a tag run) or keeps it as the artifact `store-exe-dryrun`; `publish` then expects exactly that asset;
  the file is not named `*-setup.exe`, so `latest.json` and the updater never use it (the installed app still updates itself with the normal installer);
- `pages.yml` adds the installers of the newest 3 published releases to the website under `/downloads/<V>/` after checking every one against the sha256 digest and size GitHub states for the asset, and `robots.txt` blocks `/downloads/`;
  the address Partner Center is given never changes for a published version and answers 200 without a redirect;
- the job `store-url` (after `publish`) checks the Authenticode signature, starts `pages.yml` on `main` and, when it is deployed, checks the address from outside (200, no `Location`, size, sha256). **`pages.yml` on `main` must already be the one with
  this step: merge the release branch first**, or use "Re-run failed jobs" after the merge;
- with `STORE_SUBMIT` = `true` too, the job `store-submit-exe` puts the new address into the submission of the EXE product (variable `STORE_EXE_PRODUCT_ID`, a separate Partner Center product; the first submission by hand) with `msstore submission get / update / publish / poll`.

**Not built: the signature (W14.3).** Microsoft takes an EXE installer only if the installer and every program file in it are signed by the publisher with a certificate of the Trusted Root Program
(a self-signed one is refused). Today there is no such certificate: `store-exe` says "not signed" and `store-url` refuses an unsigned file. The route is the SignPath Foundation (free for open source, publisher shown as
"SignPath Foundation") or a certificate bought for about 150-300 USD a year; both are your accounts and your money, so they are only set up on a trigger. Hosting through your Caddy server means every Store
install downloads about 135 MB from your home connection.
