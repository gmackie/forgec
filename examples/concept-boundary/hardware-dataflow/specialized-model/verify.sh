#!/bin/sh
# Directed simulation only; no synthesis or CDC/timing analysis.
set -eu
cd "$(dirname "$0")"
python3 - <<'PY'
import hashlib, json
from pathlib import Path
receipt = json.loads(Path('verification.json').read_text())
for name, expected in receipt['inputs'].items():
    assert hashlib.sha256(Path(name).read_bytes()).hexdigest() == expected, name
PY
work_dir=$(mktemp -d "${TMPDIR:-/tmp}/forge-boundary-rtl.XXXXXX")
trap 'rm -rf "$work_dir"' EXIT HUP INT TERM
iverilog -g2012 -s elastic_stage_tb -o "$work_dir/elastic.vvp" elastic_stage.sv elastic_stage_tb.sv
vvp "$work_dir/elastic.vvp"
