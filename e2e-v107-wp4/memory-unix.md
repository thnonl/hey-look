# W4.8 kit, macOS and Linux (shell lines for the QA briefs; spec-107-wp4.md REQ-4.8.1/4.8.2). Not part of the repo.

Same rules as `memory.ps1`: the RELEASE build of the CI dry run (not the debug build), standard mail (QA newsletter with remote pictures for readers, a 20 KB formatted reply for
compose), 20 s idle, value per window = (memory with n windows - memory with none) / n, for n = 1, 3, 6 of compose and of reader, and once for 1 event + 1 Settings + 1 search window.
Quit Safari, Mail and every other WebKit app first on a Mac (they have their own WebContent processes).

## macOS: `phys_footprint` of the app plus its new WebContent / GPU / Networking processes

```sh
APP=$(pgrep -x "Hey Look!" | head -1)            # the app process
# processes that appeared after the app started: WebKit helpers started by it (their parent is the app, or launchd for the shared GPU / Networking ones; take those whose start time is later than the app's)
APP_START=$(ps -o lstart= -p "$APP")
helpers() { ps -axo pid=,lstart=,comm= | awk -v s="$APP_START" '/com.apple.WebKit\.(WebContent|GPU|Networking)/ { print $1 }' ; }
mem() {            # MB of phys_footprint, summed over the app and its helpers
  total=0
  for p in "$APP" $(helpers); do
    kb=$(footprint -p "$p" 2>/dev/null | awk '/phys_footprint:/ {v=$2; u=$3; if (u ~ /GB/) v*=1024; if (u ~ /KB/) v/=1024; print v}' | head -1)
    total=$(echo "$total + ${kb:-0}" | bc)
  done
  echo "$total"
}
read -p "no secondary windows; Enter" _; sleep 20; BASE=$(mem); echo "baseline $BASE MB"
read -p "open N windows (standard mail), wait until drawn; Enter" _; sleep 20; WITH=$(mem); echo "with N: $WITH MB"
echo "per window: $(echo "($WITH - $BASE) / N" | bc -l) MB"        # replace N
```

Notes: `footprint -p <pid>` prints `phys_footprint: <n> MB` (the unit varies; the awk above converts GB and KB). Write the macOS and chip, `sw_vers`, `pgrep -x WebContent | wc -l` before and after.
With the debug bridge build (only for the macOS leak run, W4.1) the app's own number is also `GET /native` `footprintBytes`; for W4.8 use the release build and the lines above.

## Linux (ARM VM, KDE): PSS of the app plus its `WebKitWebProcess` / `WebKitNetworkProcess` children

```sh
APP=$(pgrep -x hey-look | head -1)
mem() {            # MB of PSS over the app and its WebKit children (smaps_rollup)
  total=0
  for p in "$APP" $(pgrep -P "$APP" -f 'WebKit(Web|Network)Process'); do
    kb=$(awk '/^Pss:/ {print $2}' "/proc/$p/smaps_rollup" 2>/dev/null)
    total=$(( total + ${kb:-0} ))
  done
  echo $(( total / 1024 ))
}
read -p "no secondary windows; Enter" _; sleep 20; BASE=$(mem); echo "baseline $BASE MB"
read -p "open N windows; Enter" _; sleep 20; WITH=$(mem); echo "with N: $WITH MB"
echo "per window: $(( (WITH - BASE) / N )) MB"                     # replace N
```

The VM is ARM (owner decision: no x86_64 machine): write `uname -m`, the WebKitGTK version (`pkg-config --modversion webkit2gtk-4.1`) and the desktop in the result.

## The decision rule (REQ-4.8.3)

Every value <= 150 MB on all three systems: the cap `MAX_SECONDARY` = 8 stays (D-6 confirmed). Otherwise cap = floor(1200 MB / the largest value), at least 4; the owner decides (a change of
`MAX_SECONDARY` in `src-tauri/src/popout.rs` is one line plus its test `at_most_eight_windows_all_kinds_together`).
