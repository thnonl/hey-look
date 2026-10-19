# Linux stores: Snap Store and AppImageHub

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
nor the automatic-check switch. The AppImage, `.deb` and `.rpm` keep the in-app updater.

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
