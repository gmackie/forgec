#!/usr/bin/env python3
"""Live, disposable Artifacts qualification. No credentials enter evidence/stdout.
Run with --help. The state directory is private and supports explicit cleanup.
"""

from artifact_probe import probe
import argparse
import concurrent.futures
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

if not __debug__:
    raise SystemExit("Qualification requires assertions; do not use python -O")

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--account", required=True)
parser.add_argument(
    "--credential-file",
    required=True,
    help="Wrangler TOML credential reference; never a token value",
)
parser.add_argument("--state-dir", required=True)
parser.add_argument("--evidence", required=True)
parser.add_argument("--cleanup-only", action="store_true")
parser.add_argument(
    "--keep-on-failure",
    action="store_true",
    help="Retain private disposable resources for diagnosis; cleanup explicitly afterward",
)
args = parser.parse_args()
root = pathlib.Path(__file__).resolve().parent.parent
state_dir = pathlib.Path(args.state_dir).expanduser()
state_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
state_path = state_dir / "state.json"
credential = tomllib.loads(pathlib.Path(args.credential_file).expanduser().read_text())[
    "oauth_token"
]
base = f"https://api.cloudflare.com/client/v4/accounts/{args.account}"


def api(path, method="GET", body=None, raw=None, content_type=None):
    headers = {
        "Authorization": "Bearer " + credential,
        "User-Agent": "forge-artifact-qualification",
    }
    if body is not None:
        raw = json.dumps(body).encode()
        content_type = "application/json"
    if content_type:
        headers["Content-Type"] = content_type
    request = urllib.request.Request(
        base + path, data=raw, headers=headers, method=method
    )
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            payload = response.read()
            try:
                result = json.loads(payload)
            except ValueError:
                raise RuntimeError(
                    f"Cloudflare API returned non-JSON HTTP {response.status} for {method} {path.split(chr(63))[0]}"
                ) from None
            if not result.get("success"):
                raise RuntimeError("Cloudflare operation rejected")
            return result.get("result")
    except urllib.error.HTTPError as error:
        raise RuntimeError(
            f"Cloudflare HTTP {error.code} on {method} {path.split('?')[0]}"
        ) from None


def save():
    fd = os.open(state_path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as out:
        json.dump(state, out)


state = json.loads(state_path.read_text()) if state_path.exists() else None
if state is None:
    suffix = secrets.token_hex(6)
    state = {
        "account": args.account,
        "namespace": "forge-runtime-cert",
        "repo": "probe-" + suffix,
        "fork": "fork-" + suffix,
        "worker": "forge-artifact-" + suffix,
        "secret": secrets.token_urlsafe(32),
        "tests": [],
        "created": [],
    }
    save()
if state["account"] != args.account:
    raise RuntimeError("State account mismatch")
ns = "/artifacts/namespaces/" + state["namespace"]


def record(name, **details):
    state["tests"].append({"name": name, "status": "passed", **details})
    save()
    print(name, flush=True)


def cleanup():
    failures = []
    for kind, name in reversed(state["created"][:]):
        path = (
            ("/workers/scripts/" + name) if kind == "worker" else ns + "/repos/" + name
        )
        try:
            api(path, "DELETE")
            state["created"].remove([kind, name])
            save()
        except RuntimeError as e:
            if "HTTP 404 " in str(e):
                state["created"].remove([kind, name])
                save()
            else:
                failures.append(str(e))
    return failures


def evidence(status, cleanup_failures):
    value = {
        "at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "status": status,
        "scope": "Disposable live Cloudflare Artifacts repository, real Git smart HTTP, and actual Workers binding through Forge reader",
        "runtimeBase": "b165fd1b052a",
        "tests": state["tests"],
        "transportEvents": state.get("transportEvents", []),
        "cleanup": {
            "remainingResources": [{"type": k, "name": n} for k, n in state["created"]],
            "errors": cleanup_failures,
        },
        "workerSha256": state.get("workerHash"),
        "gitVersion": subprocess.check_output(["git", "--version"], text=True).strip(),
    }
    path = pathlib.Path(args.evidence)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2) + "\n")


if args.cleanup_only:
    failures = cleanup()
    evidence("cleanup_failed" if failures else "cleaned", failures)
    raise SystemExit(bool(failures))
if state["created"]:
    raise RuntimeError(
        "Previous resources remain; use --cleanup-only before a fresh state directory"
    )


def git(argv, input=None, token=None, cwd=None):
    env = {
        **os.environ,
        "GIT_CONFIG_NOSYSTEM": "1",
        "GIT_CONFIG_GLOBAL": "/dev/null",
        "GIT_TERMINAL_PROMPT": "0",
        "GIT_AUTHOR_NAME": "Forge qualification",
        "GIT_AUTHOR_EMAIL": "fixture@example.invalid",
        "GIT_COMMITTER_NAME": "Forge qualification",
        "GIT_COMMITTER_EMAIL": "fixture@example.invalid",
    }
    # Secret header is process environment only, never command arguments/config.
    if token:
        env.update(
            GIT_CONFIG_COUNT="1",
            GIT_CONFIG_KEY_0="http.extraHeader",
            GIT_CONFIG_VALUE_0="Authorization: Bearer " + token,
        )
    return subprocess.run(
        ["git", *argv], input=input, capture_output=True, cwd=cwd, env=env, timeout=60
    )


def mustgit(argv, input=None, token=None, cwd=None):
    result = git(argv, input, token, cwd)
    if result.returncode:
        raise RuntimeError("Git fixture operation failed: " + argv[0])
    return result.stdout.decode().strip()


def remote_head(token, remote, ref="refs/heads/main"):
    return mustgit(["ls-remote", remote, ref], token=token).split()[0]


def push(oid, old, token, remote, directory):
    return git(
        [
            "push",
            "--porcelain",
            "--force-with-lease=refs/heads/main:" + old,
            remote,
            oid + ":refs/heads/main",
        ],
        token=token,
        cwd=directory,
    )


def worker(body, expected=200, auth=True):
    headers = {
        "Content-Type": "application/json",
        "User-Agent": "Mozilla/5.0 ForgeArtifactQualification",
    }
    if auth:
        headers["Authorization"] = "Bearer " + state["secret"]
    request = urllib.request.Request(
        state["workerUrl"], data=json.dumps(body).encode(), headers=headers
    )

    def send():
        try:
            with urllib.request.urlopen(request, timeout=45) as response:
                return response.status, response.read()
        except urllib.error.HTTPError as error:
            return error.code, error.read()

    def transport_event(event):
        state.setdefault("transportEvents", []).append(
            {"action": body["action"], **event}
        )
        save()

    status, data = probe(send, transport_event)
    if status != expected:
        raise RuntimeError(
            f"Qualification Worker expected {expected}, received {status}, code {data.get('code') if isinstance(data, dict) else 'unknown'}"
        )
    return data


status = "failed"
try:
    # Record generated resource identities before create, so uncertain responses can be cleaned up.
    state["created"].append(["repo", state["repo"]])
    save()
    repo = api(
        ns + "/repos",
        "POST",
        {
            "name": state["repo"],
            "default_branch": "main",
            "description": "Disposable Forge runtime qualification",
        },
    )
    remote = repo["remote"]
    write_token = repo["token"]
    state["repoId"] = repo["id"]
    save()
    record("Disposable repository created")
    directory = state_dir / "fixture.git"
    directory.mkdir()
    mustgit(["init", "--bare"], cwd=directory)

    def obj(kind, content):
        return mustgit(
            ["hash-object", "-t", kind, "-w", "--stdin"], content, cwd=directory
        )

    blob = obj("blob", bytes([0, 1, 2, 128, 255]))
    tree = mustgit(
        ["mktree"], f"100644 blob {blob}\tdata.bin\n".encode(), cwd=directory
    )

    def commit(parents, message):
        return mustgit(
            ["commit-tree", tree, *[x for parent in parents for x in ["-p", parent]]],
            (message + "\n").encode(),
            cwd=directory,
        )

    root_commit = commit([], "root")
    left = commit([root_commit], "left")
    right = commit([root_commit], "right")
    merge = commit([left, right], "merge")
    if push(merge, "", write_token, remote, directory).returncode:
        raise RuntimeError("Initial expected-absent publication failed")
    assert remote_head(write_token, remote) == merge
    record("Git expected-absent push publishes merge DAG")
    # Build the actual reader into a Worker, without a Node host or REST-shaped double.
    bundle = state_dir / "worker.mjs"
    code = "const {createRequire}=require('node:module');const r=createRequire(process.argv[1]);r('esbuild').buildSync({entryPoints:[process.argv[2]],outfile:process.argv[3],bundle:true,format:'esm',platform:'browser',target:'es2022',conditions:['source']});"
    result = subprocess.run(
        [
            "node",
            "-e",
            code,
            str(root / "examples/acme/package.json"),
            str(root / "conformance/artifacts/worker.ts"),
            str(bundle),
        ],
        capture_output=True,
    )
    if result.returncode:
        raise RuntimeError("Worker bundle failed")
    source = bundle.read_bytes()
    state["workerHash"] = hashlib.sha256(source).hexdigest()
    save()
    metadata = {
        "main_module": "worker.mjs",
        "compatibility_date": "2026-10-01",
        "bindings": [
            {"name": "ARTIFACTS", "type": "artifacts", "namespace": state["namespace"]},
            {
                "name": "QUALIFICATION_SECRET",
                "type": "secret_text",
                "text": state["secret"],
            },
            {"name": "REPO_NAME", "type": "plain_text", "text": state["repo"]},
            {"name": "REPO_ID", "type": "plain_text", "text": repo["id"]},
        ],
    }
    boundary = "forge" + secrets.token_hex(12)
    parts = []
    for name, mime, content in [
        ("metadata", "application/json", json.dumps(metadata).encode()),
        ("worker.mjs", "application/javascript+module", source),
    ]:
        parts.append(
            f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"; filename="{name}"\r\nContent-Type: {mime}\r\n\r\n'.encode()
            + content
            + b"\r\n"
        )
    payload = b"".join(parts) + f"--{boundary}--\r\n".encode()
    state["created"].append(["worker", state["worker"]])
    save()
    api(
        "/workers/scripts/" + state["worker"],
        "PUT",
        raw=payload,
        content_type="multipart/form-data; boundary=" + boundary,
    )
    api("/workers/scripts/" + state["worker"] + "/subdomain", "POST", {"enabled": True})
    record("Disposable qualification Worker deployed with native Artifacts binding")
    subdomain = api("/workers/subdomain")["subdomain"]
    state["workerUrl"] = "https://" + state["worker"] + "." + subdomain + ".workers.dev"
    save()
    pin = worker({"action": "resolve"})
    assert pin["oid"] == merge and pin["tree"] == tree
    record("Actual Workers binding resolves exact repository, commit and tree")
    assert worker({"action": "file", "pin": pin, "path": "data.bin"})["bytes"] == [
        0,
        1,
        2,
        128,
        255,
    ]
    record("Actual Workers binding returns exact pinned binary bytes")
    history = worker({"action": "history", "pin": pin})
    assert [x["oid"] for x in history] == [merge, left, root_commit, right]
    record(
        "Actual Workers binding traverses both merge parents and deduplicates ancestor"
    )
    assert (
        worker({"action": "history", "pin": pin, "maxCommits": 2}, 422)["code"]
        == "BudgetExceeded"
    )
    assert (
        worker({"action": "file", "pin": pin, "path": "data.bin", "maxBytes": 2}, 422)[
            "code"
        ]
        == "BudgetExceeded"
    )
    record("Live history and byte budgets fail explicitly")
    assert worker({"action": "resolve"}, 401, False)["code"] == "Unauthenticated"
    assert (
        worker({"action": "file", "pin": pin, "path": "data.bin", "deny": True}, 403)[
            "code"
        ]
        == "NotPermitted"
    )
    assert (
        worker(
            {"action": "file", "pin": pin, "path": "data.bin", "tenant": "foreign"}, 403
        )["code"]
        == "NotPermitted"
    )
    record("Worker authentication and reader authorization reject unauthorized access")
    a = commit([merge], "concurrent-a")
    b = commit([merge], "concurrent-b")
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        results = list(
            pool.map(
                lambda oid: push(oid, merge, write_token, remote, directory), [a, b]
            )
        )
    assert sum(r.returncode == 0 for r in results) == 1
    winner = remote_head(write_token, remote)
    assert winner in [a, b]
    record("Concurrent expected-head pushes admit exactly one winner")
    assert push(root_commit, merge, write_token, remote, directory).returncode != 0
    assert remote_head(write_token, remote) == winner
    record("Stale expected head cannot overwrite accepted publication")
    assert worker({"action": "resolve"})["oid"] == winner
    assert [x["oid"] for x in worker({"action": "history", "pin": pin})] == [
        merge,
        left,
        root_commit,
        right,
    ]
    record("Old pin remains exact after published branch moves")
    read = api(
        ns + "/tokens", "POST", {"repo": state["repo"], "scope": "read", "ttl": 120}
    )
    assert remote_head(read["plaintext"], remote) == winner
    assert (
        push(root_commit, winner, read["plaintext"], remote, directory).returncode != 0
    )
    record("Read token fetches but cannot publish")
    api(ns + "/tokens/" + read["id"], "DELETE")
    assert git(["ls-remote", remote], token=read["plaintext"]).returncode != 0
    record("Revoked repository token cannot read")
    state["created"].append(["repo", state["fork"]])
    save()
    fork = api(
        ns + "/repos/" + state["repo"] + "/fork",
        "POST",
        {"name": state["fork"], "default_branch_only": False},
    )
    for attempt in range(12):
        try:
            assert remote_head(fork["token"], fork["remote"]) == winner
            break
        except Exception:
            if attempt == 11:
                raise
            time.sleep(2)
    assert fork["id"] != repo["id"]
    record("Fork becomes ready with separate repository identity and exact baseline")
    assert git(["ls-remote", fork["remote"]], token=write_token).returncode != 0
    record("Repository token cannot cross into a fork")
    export = state_dir / "export.git"
    mustgit(["clone", "--mirror", remote, str(export)], token=write_token)
    mustgit(["fsck", "--full"], cwd=export)
    assert set(mustgit(["rev-list", "--all"], cwd=export).splitlines()) == {
        winner,
        merge,
        left,
        right,
        root_commit,
    }
    assert git(["cat-file", "blob", merge + ":data.bin"], cwd=export).stdout == bytes(
        [0, 1, 2, 128, 255]
    )
    record("Git mirror export preserves complete reachable DAG and binary content")
    # This name is solely this run's disposable resource. Deletion tests repository-ID fencing.
    api(ns + "/repos/" + state["repo"], "DELETE")
    for attempt in range(20):
        try:
            replacement = api(
                ns + "/repos", "POST", {"name": state["repo"], "default_branch": "main"}
            )
            break
        except RuntimeError:
            if attempt == 19:
                raise
            time.sleep(2)
    assert replacement["id"] != repo["id"]
    assert worker({"action": "resolve"}, 412)["code"] == "VersionConflict"
    record("Deleted and recreated repository name cannot reuse an old binding")
    status = "passed"
except Exception as error:
    # Only our explicit sanitized errors / assertion type, never raw subprocess/network output.
    print(
        "Qualification failed:",
        str(error) if isinstance(error, RuntimeError) else type(error).__name__,
        flush=True,
    )
finally:
    failures = [] if status != "passed" and args.keep_on_failure else cleanup()
    evidence(status if not failures else "cleanup_failed", failures)
    print(
        "Evidence written; remaining disposable resources:",
        len(state["created"]),
        flush=True,
    )
raise SystemExit(0 if status == "passed" and not failures else 1)
