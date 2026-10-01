#!/usr/bin/env python3
"""Qualify the runtime publisher against disposable Cloudflare Artifacts and D1."""

import argparse
import hashlib
import json
import os
import pathlib
import secrets
import subprocess
import time
import tomllib
import urllib.error
import urllib.request

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--account", required=True)
parser.add_argument("--credential-file", required=True)
parser.add_argument("--state-dir", required=True)
parser.add_argument("--evidence", required=True)
parser.add_argument("--cleanup-only", action="store_true")
args = parser.parse_args()
root = pathlib.Path(__file__).resolve().parent.parent
state_dir = pathlib.Path(args.state_dir).expanduser()
state_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
state_path = state_dir / "state.json"
credential = tomllib.loads(pathlib.Path(args.credential_file).expanduser().read_text())[
    "oauth_token"
]
base = "https://api.cloudflare.com/client/v4/accounts/" + args.account
state = (
    json.loads(state_path.read_text())
    if state_path.exists()
    else {
        "account": args.account,
        "name": "forge-publish-" + secrets.token_hex(8),
        "resources": [],
    }
)
if state["account"] != args.account:
    raise SystemExit("State account mismatch")


def save():
    fd = os.open(state_path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as out:
        json.dump(state, out)


def api(path, method="GET", body=None):
    request = urllib.request.Request(
        base + path,
        method=method,
        headers={
            "Authorization": "Bearer " + credential,
            "Content-Type": "application/json",
        },
        data=json.dumps(body).encode() if body is not None else None,
    )
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            data = json.load(response)
            if not data.get("success"):
                raise RuntimeError("Cloudflare operation rejected")
            return data.get("result")
    except urllib.error.HTTPError as error:
        raise RuntimeError("Cloudflare HTTP " + str(error.code)) from None


def cleanup():
    failures = []
    for kind in reversed(state["resources"][:]):
        try:
            if kind == "repo":
                api(
                    "/artifacts/namespaces/forge-runtime-cert/repos/" + state["name"],
                    "DELETE",
                )
            else:
                # Reconcile creation by our random owned name if the response was lost.
                ids = (
                    [state["database"]]
                    if state.get("database")
                    else [
                        d["uuid"]
                        for d in api("/d1/database?name=" + state["name"])
                        if d["name"] == state["name"]
                    ]
                )
                for database in ids:
                    api("/d1/database/" + database, "DELETE")
            state["resources"].remove(kind)
            save()
        except Exception as error:
            if isinstance(error, RuntimeError) and str(error) == "Cloudflare HTTP 404":
                state["resources"].remove(kind)
                save()
            else:
                failures.append(
                    str(error)
                    if isinstance(error, RuntimeError)
                    else type(error).__name__
                )
    return failures


result = {"status": "failed", "tests": []}
try:
    if not args.cleanup_only:
        if state["resources"] or (state_dir / "fixture.git").exists():
            raise RuntimeError(
                "Use a fresh state directory; cleanup existing resources with --cleanup-only"
            )
        built = subprocess.run(
            ["pnpm", "--filter", "@forgegraph/runtime", "build"],
            cwd=root,
            capture_output=True,
        )
        if built.returncode:
            raise RuntimeError("Runtime build failed")
        state["resources"].append("repo")
        save()
        repo = api(
            "/artifacts/namespaces/forge-runtime-cert/repos",
            "POST",
            {"name": state["name"], "default_branch": "main"},
        )
        state["resources"].append("d1")
        save()
        database = api("/d1/database", "POST", {"name": state["name"]})
        state["database"] = database["uuid"]
        save()
        print("Disposable Artifacts repository and D1 journal created", flush=True)
        config = {
            "account": args.account,
            "credential": credential,
            "token": repo["token"],
            "remote": repo["remote"],
            "repo": state["name"],
            "repoId": repo["id"],
            "database": database["uuid"],
            "directory": str(state_dir / "fixture.git"),
        }
        run = subprocess.run(
            ["node", str(root / "conformance/artifacts/publish-live.mjs")],
            input=json.dumps(config),
            capture_output=True,
            text=True,
            timeout=600,
            cwd=root,
        )
        try:
            result = json.loads(run.stdout)
        except ValueError:
            raise RuntimeError(
                "Publication runner failed without structured evidence"
            ) from None
        if run.returncode or result.get("status") != "passed":
            result["status"] = "failed"
        for test in result.get("tests", []):
            print(test["name"], flush=True)
    else:
        result = {"status": "cleaned", "tests": []}
except Exception as error:
    result["status"] = "failed"
    result["error"] = (
        str(error) if isinstance(error, RuntimeError) else type(error).__name__
    )
    print("Qualification failed:", result["error"], flush=True)
finally:
    failures = cleanup()
    if failures:
        result["status"] = "cleanup_failed"
    sources = [
        "conformance/artifacts/publish-live.mjs",
        "packages/runtime/src/artifact-publication.ts",
        "packages/runtime/src/adapters/artifact-publication-git.ts",
        "packages/runtime/src/adapters/artifact-publication-sql.ts",
    ]
    result.update(
        at=time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        scope="Actual Node ArtifactPublisher and Git transport with live Cloudflare Artifacts plus live D1 SQL journal over REST",
        sourceSha256={
            p: hashlib.sha256((root / p).read_bytes()).hexdigest() for p in sources
        },
        cleanup={"remainingResources": state["resources"], "errors": failures},
        nodeVersion=subprocess.check_output(["node", "--version"], text=True).strip(),
        gitVersion=subprocess.check_output(["git", "--version"], text=True).strip(),
    )
    evidence = pathlib.Path(args.evidence)
    evidence.parent.mkdir(parents=True, exist_ok=True)
    evidence.write_text(json.dumps(result, indent=2) + "\n")
    print(
        "Evidence written; remaining disposable resources:",
        len(state["resources"]),
        flush=True,
    )
raise SystemExit(0 if result["status"] in ("passed", "cleaned") else 1)
