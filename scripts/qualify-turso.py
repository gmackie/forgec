#!/usr/bin/env python3
"""Disposable hosted Turso qualification; management token remains in environment."""

import argparse
import hashlib
import json
import os
import pathlib
import secrets
import re
import subprocess
import time
import urllib.request
import urllib.error

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--organization", required=True)
parser.add_argument("--credential-env", default="TURSO_API_KEY")
parser.add_argument("--group", default="default")
parser.add_argument("--state-dir", required=True)
parser.add_argument("--evidence", required=True)
parser.add_argument("--cleanup-only", action="store_true")
args = parser.parse_args()
for value in (args.organization, args.group):
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]{0,62}", value):
        raise SystemExit("Invalid organization or group")
credential = os.environ.get(args.credential_env)
if not credential:
    raise SystemExit("Management credential reference is unavailable")
root = pathlib.Path(__file__).resolve().parent.parent
state_dir = pathlib.Path(args.state_dir).expanduser()
state_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
state_path = state_dir / "state.json"
state = (
    json.loads(state_path.read_text())
    if state_path.exists()
    else {
        "organization": args.organization,
        "database": "forge-cert-" + secrets.token_hex(8),
        "owned": False,
    }
)
if state["organization"] != args.organization:
    raise SystemExit("State organization mismatch")
if not re.fullmatch(r"forge-cert-[0-9a-f]{16}", state.get("database", "")):
    raise SystemExit("State database is outside the disposable namespace")
if state["owned"] and not args.cleanup_only:
    raise SystemExit("Previous database remains; use --cleanup-only")
evidence_path = pathlib.Path(args.evidence)
evidence_path.parent.mkdir(parents=True, exist_ok=True)


def save():
    fd = os.open(state_path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        json.dump(state, f)


def api(path, method="GET", body=None):
    request = urllib.request.Request(
        "https://api.turso.tech/v1/organizations/" + args.organization + path,
        method=method,
        headers={
            "Authorization": "Bearer " + credential,
            "Content-Type": "application/json",
        },
        data=json.dumps(body).encode() if body is not None else None,
    )
    try:
        with urllib.request.urlopen(request, timeout=45) as response:
            raw = response.read()
            return json.loads(raw) if raw else {}
    except urllib.error.HTTPError as error:
        raise RuntimeError("Turso HTTP " + str(error.code)) from None
    except Exception as error:
        raise RuntimeError(
            "Turso transport or response failure: " + type(error).__name__
        ) from None


result = {"status": "failed", "tests": []}
try:
    if args.cleanup_only:
        result["status"] = "cleaned"
    else:
        if state["owned"]:
            raise RuntimeError("Previous database remains; use --cleanup-only")
        state["owned"] = True
        save()
        value = api(
            "/databases", "POST", {"name": state["database"], "group": args.group}
        )
        database = value["database"]
        hostname = (
            database["Hostname"] if "Hostname" in database else database["hostname"]
        )
        token = api(
            "/databases/"
            + state["database"]
            + "/auth/tokens?expiration=1h&authorization=full-access",
            "POST",
        )
        config = {"url": "libsql://" + hostname, "token": token["jwt"]}
        run = subprocess.run(
            ["node", str(root / "conformance/turso/qualify.mjs")],
            input=json.dumps(config),
            text=True,
            capture_output=True,
            cwd=root,
            timeout=300,
        )
        try:
            result = json.loads(run.stdout)
        except ValueError:
            raise RuntimeError(
                "Qualification runner returned no structured result"
            ) from None
        if run.returncode:
            result["status"] = "failed"
        for test in result.get("tests", []):
            print(test["name"], flush=True)
except Exception as error:
    result["status"] = "failed"
    result["error"] = (
        str(error) if isinstance(error, RuntimeError) else type(error).__name__
    )
finally:
    errors = []
    if state["owned"]:
        try:
            api("/databases/" + state["database"], "DELETE")
            state["owned"] = False
            save()
        except Exception as error:
            if str(error) == "Turso HTTP 404":
                state["owned"] = False
                save()
            else:
                errors.append(
                    str(error)
                    if isinstance(error, RuntimeError)
                    else type(error).__name__
                )
                result["status"] = "cleanup_failed"
    sources = [
        "scripts/qualify-turso.py",
        "conformance/turso/qualify.mjs",
        "packages/runtime/src/adapters/libsql-executor.ts",
        "packages/runtime/src/adapters/artifact-publication-sql.ts",
        "packages/runtime/src/adapters/d1.ts",
    ]
    result.update(
        at=time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        organization=args.organization,
        credentialReference="env:" + args.credential_env,
        sourceSha256={
            p: hashlib.sha256((root / p).read_bytes()).hexdigest() for p in sources
        },
        cleanup={"remainingDatabases": int(state["owned"]), "errors": errors},
    )
    evidence_path.write_text(json.dumps(result, indent=2) + "\n")
    print(
        "Qualification", result["status"], "remaining databases:", int(state["owned"])
    )
raise SystemExit(0 if result["status"] in ["passed", "cleaned"] else 1)
