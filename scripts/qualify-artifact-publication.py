#!/usr/bin/env python3
"""Qualify the runtime publisher against disposable Cloudflare Artifacts and D1."""

from artifact_journal_worker import deploy as deploy_journal_worker
import argparse
import re
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
parser.add_argument(
    "--bob-root",
    help="Optional trusted Bob workspace for the real vault composition pilot",
)
parser.add_argument(
    "--workers-journal",
    action="store_true",
    help="Use a deployed native Workers D1 journal",
)
parser.add_argument(
    "--runner-host", help="Existing SSH host for isolated Bob HTTP qualification"
)
parser.add_argument(
    "--remote-pilot-bundle", help="Absolute path to the reviewed bundle on that host"
)
parser.add_argument(
    "--local-pilot-bundle", help="Local copy used to verify the deployed bundle digest"
)
args = parser.parse_args()
remote_options = [args.runner_host, args.remote_pilot_bundle, args.local_pilot_bundle]
if any(remote_options):
    if not all(remote_options) or not args.bob_root or args.workers_journal:
        parser.error("Remote pilot requires Bob root, host and both bundle references")
    if not re.fullmatch(r"[A-Za-z0-9_][A-Za-z0-9_.@-]*", args.runner_host):
        parser.error("Invalid SSH host reference")
    if not re.fullmatch(
        r"/[A-Za-z0-9_./-]+", args.remote_pilot_bundle
    ) or ".." in args.remote_pilot_bundle.split("/"):
        parser.error("Invalid remote bundle path")
if args.workers_journal and args.bob_root:
    parser.error("Workers journal and Bob pilot are separate qualification modes")
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


def api(path, method="GET", body=None, raw=None, content_type="application/json"):
    request = urllib.request.Request(
        base + path,
        method=method,
        headers={
            "Authorization": "Bearer " + credential,
            "Content-Type": content_type,
        },
        data=json.dumps(body).encode() if body is not None else raw,
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
            if kind == "worker":
                api("/workers/scripts/" + state["name"], "DELETE")
            elif kind == "repo":
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
        if args.workers_journal:
            state["resources"].append("worker")
            save()
            state["transportEvents"] = []

            def record_transport(event):
                state["transportEvents"].append(event)
                save()

            config["journalWorker"], state["workerSha256"] = deploy_journal_worker(
                root,
                state_dir,
                state["name"],
                database["uuid"],
                secrets.token_urlsafe(32),
                api,
                record_transport,
            )
            save()
            print(
                "Disposable Worker deployed with native D1 journal binding", flush=True
            )
        runner = root / "conformance/artifacts/publish-live.mjs"
        runner_env = dict(os.environ)
        if args.bob_root:
            runner = (
                pathlib.Path(args.bob_root).resolve()
                / "packages/ooda/scripts/verify-forge-vault.mjs"
            )
            runner_env.update(
                FORGE_RUNTIME_ROOT=str(root), FORGE_VAULT_LIVE_CONFIG="stdin"
            )
        command = ["node", str(runner)]
        if args.runner_host:
            local_digest = hashlib.sha256(
                pathlib.Path(args.local_pilot_bundle).read_bytes()
            ).hexdigest()
            remote_digest = subprocess.check_output(
                [
                    "ssh",
                    "-o",
                    "BatchMode=yes",
                    args.runner_host,
                    "sha256sum",
                    args.remote_pilot_bundle,
                ],
                text=True,
                timeout=30,
            ).split()[0]
            if remote_digest != local_digest:
                raise RuntimeError("Remote pilot bundle digest mismatch")
            state["pilotBundleSha256"] = local_digest
            save()
            command = [
                "ssh",
                "-o",
                "BatchMode=yes",
                args.runner_host,
                "docker",
                "run",
                "--rm",
                "-i",
                "--network",
                "host",
                "-e",
                "FORGE_RUNTIME_ROOT=bundled",
                "-e",
                "FORGE_VAULT_LIVE_CONFIG=stdin",
                "-e",
                "FORGE_VAULT_HTTP=true",
                "-v",
                args.remote_pilot_bundle + ":/pilot.mjs:ro",
                "node:24.14.0",
                "node",
                "/pilot.mjs",
            ]
        run = subprocess.run(
            command,
            input=json.dumps(config),
            capture_output=True,
            text=True,
            timeout=600,
            cwd=root,
            env=runner_env,
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
        "packages/runtime/src/artifact-publication.ts",
        "packages/runtime/src/adapters/artifact-publication-git.ts",
        "packages/runtime/src/adapters/artifact-publication-sql.ts",
    ]
    if not args.bob_root:
        sources.append("conformance/artifacts/publish-live.mjs")
    if args.bob_root:
        bob_root = pathlib.Path(args.bob_root).resolve()
        bob_files = [
            "packages/ooda/scripts/forge-vault-http-host.ts",
            "packages/ooda/scripts/build-forge-vault-pilot.mjs",
            "packages/ooda/scripts/verify-forge-vault.mjs",
            "packages/ooda/src/vault/forge-publication-storage.ts",
            "packages/ooda/src/vault/vault-service.ts",
            "packages/ooda/src/vault/git.ts",
        ]
        result["bobSourceSha256"] = {
            p: hashlib.sha256((bob_root / p).read_bytes()).hexdigest()
            for p in bob_files
            if (bob_root / p).exists()
        }
    if args.workers_journal:
        sources.extend(
            [
                "conformance/artifacts/journal-worker.ts",
                "scripts/artifact_journal_worker.py",
            ]
        )
        result["journalHost"] = "deployed Workers native D1 binding"
        result["workerSha256"] = state.get("workerSha256")
        result["transportEvents"] = state.get("transportEvents", [])
    if args.runner_host:
        result["pilotHost"] = (
            "isolated existing runner host, Node 24 container, loopback HTTP"
        )
        result["pilotBundleSha256"] = state.get("pilotBundleSha256")
    result.update(
        at=time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        scope=(
            "Actual Bob vault composed with Forge publisher, Cloudflare Artifacts and live D1 journal"
            if args.bob_root
            else "Actual Node ArtifactPublisher and Git transport with live Cloudflare Artifacts plus deployed Workers D1 journal"
            if args.workers_journal
            else "Actual Node ArtifactPublisher and Git transport with live Cloudflare Artifacts plus live D1 SQL journal over REST"
        ),
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
