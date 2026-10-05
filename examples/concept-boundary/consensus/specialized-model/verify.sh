#!/bin/sh
# Offline runner. Obtain the official jar separately; never download in tests.
set -eu
cd "$(dirname "$0")"
: "${TLA2TOOLS_JAR:?Set TLA2TOOLS_JAR to the local official TLC jar}"
python3 - "$TLA2TOOLS_JAR" <<'PY'
import hashlib, json, sys
from pathlib import Path
receipt = json.loads(Path('verification.json').read_text())
for name, expected in receipt['inputs'].items():
    assert hashlib.sha256(Path(name).read_bytes()).hexdigest() == expected, name
assert hashlib.sha256(Path(sys.argv[1]).read_bytes()).hexdigest() == receipt['tool']['sha256'], 'TLC jar digest differs from recorded tool'
PY
state_dir=$(mktemp -d "${TMPDIR:-/tmp}/forge-boundary-tlc.XXXXXX")
trap 'rm -rf "$state_dir"' EXIT HUP INT TERM
java -XX:+UseParallelGC -cp "$TLA2TOOLS_JAR" tlc2.TLC -workers 1 -metadir "$state_dir" -config BoundedQuorum.cfg BoundedQuorum.tla
