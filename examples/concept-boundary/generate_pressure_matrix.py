"""Render the research classifications; --check detects a stale review matrix."""
import argparse
import json
from pathlib import Path

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--check", action="store_true")
args = parser.parse_args()
root = Path(__file__).resolve().parent
manifest = json.loads((root / "manifest.json").read_text())
fixtures = {
    slug: json.loads((root / slug / "boundary.json").read_text())
    for slug in manifest["fixtures"]
}
lines = [
    "# Semantic pressure matrix",
    "",
    "Generated from the concern classifications in each `boundary.json`. Each link opens the fixture's reasoned boundary map. A = native coordination; B = proposed facet/pattern; C = external semantics. Layers and outcomes apply to the named concern, not the entire domain.",
    "",
    "Regenerate with `python3 examples/concept-boundary/generate_pressure_matrix.py`; verify with `--check`.",
    "",
    "| Pressure | Witnesses and concern classifications |",
    "| --- | --- |",
]
for pressure in manifest["requiredPressures"]:
    witnesses = []
    for slug, boundary in fixtures.items():
        concerns = [c for c in boundary["concerns"] if pressure in c["pressures"]]
        if concerns:
            labels = "; ".join(f"{c['id']} ({c['layer']}, {c['outcome']})" for c in concerns)
            witnesses.append(f"[{slug}]({slug}/concept-boundary.md): {labels}")
    assert witnesses, f"Missing pressure: {pressure}"
    lines.append(f"| {pressure} | " + "<br>".join(witnesses) + " |")
content = "\n".join(lines) + "\n"
path = root / "pressure-matrix.md"
if args.check:
    assert path.read_text() == content, "Pressure matrix is stale; regenerate and review"
else:
    path.write_text(content)
