"""PAR-123 cross-language wire conformance runner (Python).

Usage: python3 conformance.py <base-url> <tenant>
Prints one canonical JSON array of step outcomes. The vitest harness runs the
same steps through the TypeScript and Go clients and compares.
"""
import sys
from decimal import Decimal

from forge_api import Client, InvocationFailed, ProblemError, canonical

STEPS = [
    ("create", "Customer.create", {"code": "SDK", "name": "Sdk", "tier": "gold"}),
    ("get", "Customer.get", {"id": "$create.id"}),
    ("enum", "Customer.create", {"code": "SDK2", "name": "X", "tier": "platinum"}),
    ("patch-null", "Customer.update", {"id": "$create.id", "expectedVersion": 1, "patch": {"email": None}}),
    ("patch-absent", "Customer.update", {"id": "$create.id", "expectedVersion": 2, "patch": {"tier": "standard"}}),
    ("stale", "Customer.update", {"id": "$create.id", "expectedVersion": 1, "patch": {"name": "Stale"}}),
    ("site", "Site.create", {"customer": "$create.id", "code": "S1", "name": "Site 1", "timezone": "UTC"}),
    ("order", "Order.create", {"customer": "$create.id", "site": "$site.id", "subtotal": "10.10", "tax": "0.20", "requestedOn": "2026-09-20"}),
    ("transition", "Order.status.approve", {"id": "$order.id", "expectedVersion": 1, "input": {}}),
    ("job", "ProcessOrder.start", {"order": "$order.id", "expectedVersion": 1}),
    ("page", "Customer.list.byTier", {"params": {"tier": "standard"}, "limit": 5}),
    ("missing", "Customer.get", {"id": "nope"}),
]


def main() -> int:
    base, tenant = sys.argv[1], sys.argv[2]
    client = Client(base, dev=(tenant, "sdk-python"))
    out = []
    seen = {}

    def bind(v):
        # "$step.field" placeholders chain ids from earlier steps
        if isinstance(v, str) and v.startswith("$"):
            step, field = v[1:].split(".", 1)
            return seen[step][field]
        if isinstance(v, dict):
            return {k: bind(x) for k, x in v.items()}
        return v

    for name, op, inp in STEPS:
        try:
            value = client.call(op, bind(inp))
            seen[name] = value
            if name == "job":
                value = {k: value.get(k) for k in ("workflow", "status", "version")}
            # decimals stay exact: the money total is a Decimal, not a float
            if name == "order":
                assert isinstance(value["total"], str) and Decimal(value["total"]) == Decimal("10.30"), value["total"]
            out.append({"step": name, "kind": "ok", "value": value})
        except ProblemError as e:
            out.append({"step": name, "kind": "error", "problem": {"code": e.code, "status": e.status, "fields": sorted(f["path"] for f in e.fields)}})
        except InvocationFailed as e:
            out.append({"step": name, "kind": "invocationFailed", "reason": e.reason})
    sys.stdout.write(canonical(out) + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
