#!/usr/bin/env bash
# Prints the CHANGELOG.md section for a version, without its "## <version>" heading line.
# The heading is matched literally (dots are not wildcards). Fails when the section is missing or
# still holds the date placeholder "xx".  Usage: changelog-section.sh 1.0.0 [path/to/CHANGELOG.md]
set -euo pipefail
v="${1:?usage: changelog-section.sh <version> [changelog]}"
file="${2:-CHANGELOG.md}"

section=$(awk -v h="## $v" '
  $0 == h || index($0, h " ") == 1 { f = 1; print; next }
  /^## / { f = 0 }
  f' "$file" | tr -d '\r')

if [ -z "$section" ]; then
  echo "::error::$file has no '## $v' section" >&2
  exit 1
fi
if grep -q 'xx' <<<"$section"; then
  echo "::error::the '## $v' section of $file still has the 'xx' placeholder" >&2
  exit 1
fi
tail -n +2 <<<"$section"
