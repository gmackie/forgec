#!/usr/bin/env python3
"""Qualify a disposable Artifacts management binding using Workers deployment auth."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import subprocess
import time
import urllib.error
import urllib.request
from artifact_probe import probe

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--account", required=True)
parser.add_argument("--credential-env", default="CF_ARTIFACT_CERT_TOKEN")
parser.add_argument("--state-dir", required=True)
parser.add_argument("--evidence", required=True)
parser.add_argument("--cleanup-only", action="store_true")
args = parser.parse_args()
if not re.fullmatch(r"[0-9a-f]{32}", args.account):
    raise SystemExit("Invalid account")
credential = os.environ.get(args.credential_env)
if not credential:
    raise SystemExit("Missing credential reference")
root = Path(__file__).resolve().parent.parent
private = Path(args.state_dir).expanduser()
private.mkdir(parents=True, exist_ok=True, mode=0o700)
state_path = private / "state.json"
state = (
    json.loads(state_path.read_text())
    if state_path.exists()
    else {
        "account": args.account,
        "name": "forge-binding-" + secrets.token_hex(8),
        "secret": secrets.token_urlsafe(32),
        "worker": False,
        "repo": False,
    }
)
if state["account"] != args.account or not re.fullmatch(
    r"forge-binding-[0-9a-f]{16}", state["name"]
):
    raise SystemExit("Owned state identity mismatch")
if (state["worker"] or state["repo"]) and not args.cleanup_only:
    raise SystemExit("Previous resource intent remains; use --cleanup-only")


def save():
    fd = os.open(state_path, os.O_CREAT | os.O_TRUNC | os.O_WRONLY, 0o600)
    with os.fdopen(fd, "w") as out:
        json.dump(state, out)


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


opener = urllib.request.build_opener(NoRedirect)


def request(url, token, method="GET", body=None, content_type="application/json"):
    req = urllib.request.Request(
        url,
        method=method,
        data=body,
        headers={
            "Authorization": "Bearer " + token,
            "Content-Type": content_type,
            "User-Agent": "Mozilla/5.0 ForgeArtifactQualification",
        },
    )
    try:
        with opener.open(req, timeout=45) as response:
            return response.status, response.read()
    except urllib.error.HTTPError as error:
        with error:
            return error.code, error.read()


def api(path, method="GET", body=None, content_type="application/json"):
    status, raw = request(
        "https://api.cloudflare.com/client/v4/accounts/" + args.account + path,
        credential,
        method,
        body,
        content_type,
    )
    if not 200 <= status < 300:
        raise RuntimeError("Cloudflare HTTP " + str(status))
    value = json.loads(raw)
    if not value.get("success"):
        raise RuntimeError("Cloudflare operation rejected")
    return value.get("result")


def worker(method, path):
    status, raw = request(state["url"] + path, state["secret"], method)
    if method == "DELETE" and status == 404:
        return {"deleted": True}
    if status != 200:
        raise RuntimeError("Binding Worker HTTP " + str(status))
    return json.loads(raw)


def git(directory, argv, data=None, token=None):
    env = {
        k: v
        for k, v in os.environ.items()
        if not k.startswith("GIT_") and k != args.credential_env
    }
    env.update(
        GIT_CONFIG_GLOBAL="/dev/null",
        GIT_CONFIG_NOSYSTEM="1",
        GIT_TERMINAL_PROMPT="0",
        GIT_AUTHOR_NAME="Qualification",
        GIT_AUTHOR_EMAIL="fixture@example.invalid",
        GIT_COMMITTER_NAME="Qualification",
        GIT_COMMITTER_EMAIL="fixture@example.invalid",
    )
    if token:
        env.update(
            GIT_CONFIG_COUNT="1",
            GIT_CONFIG_KEY_0="http.extraHeader",
            GIT_CONFIG_VALUE_0="Authorization: Bearer " + token,
        )
    run = subprocess.run(
        ["git", "-c", "core.hooksPath=/dev/null", *argv],
        cwd=directory,
        input=data,
        capture_output=True,
        env=env,
        timeout=60,
    )
    if run.returncode:
        raise RuntimeError("Git qualification failed")
    return run.stdout.decode().strip()


result = {"status": "failed", "tests": [], "transportEvents": []}
source = (root / "conformance/artifacts/management-worker.mjs").read_bytes()
try:
    if not args.cleanup_only:
        metadata = {
            "main_module": "worker.mjs",
            "compatibility_date": "2026-10-02",
            "bindings": [
                {
                    "name": "ARTIFACTS",
                    "type": "artifacts",
                    "namespace": "forge-runtime-cert",
                },
                {
                    "name": "QUALIFICATION_SECRET",
                    "type": "secret_text",
                    "text": state["secret"],
                },
                {"name": "REPO_NAME", "type": "plain_text", "text": state["name"]},
                {
                    "name": "EXPIRES_AT",
                    "type": "plain_text",
                    "text": str(int((time.time() + 1800) * 1000)),
                },
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
        state["worker"] = True
        save()
        api(
            "/workers/scripts/" + state["name"],
            "PUT",
            payload,
            "multipart/form-data; boundary=" + boundary,
        )
        api(
            "/workers/scripts/" + state["name"] + "/subdomain",
            "POST",
            b'{"enabled":true}',
        )
        subdomain = api("/workers/subdomain")["subdomain"]
        state["url"] = "https://" + state["name"] + "." + subdomain + ".workers.dev"
        save()
        status, value = probe(
            lambda: request(state["url"] + "/ready", state["secret"]),
            result["transportEvents"].append,
        )
        if status != 200 or value != {"ready": True}:
            raise RuntimeError("Binding Worker readiness failed")
        state["repo"] = True
        save()
        repo = worker("POST", "/create")  # Never retry an uncertain creation.
        remote = repo["remote"]
        from urllib.parse import urlsplit

        parsed = urlsplit(remote)
        if (
            parsed.scheme != "https"
            or parsed.hostname != args.account + ".artifacts.cloudflare.net"
            or parsed.username
            or parsed.password
            or parsed.query
        ):
            raise RuntimeError("Unexpected repository remote identity")
        info = worker("GET", "/repo")
        if not repo.get("id") or info.get("id") != repo["id"]:
            raise RuntimeError("Repository identity mismatch")
        result["tests"].append(
            "Native binding creates and reads the fixed disposable repository identity"
        )
        fixture = private / "fixture.git"
        fixture.mkdir()
        git(fixture, ["init", "--bare"])
        blob = git(
            fixture, ["hash-object", "-w", "--stdin"], b"binding qualification\n"
        )
        tree = git(fixture, ["mktree"], f"100644 blob {blob}\tfixture.txt\n".encode())
        commit = git(fixture, ["commit-tree", tree], b"qualification\n")
        git(
            fixture,
            [
                "push",
                "--force-with-lease=refs/heads/main:",
                remote,
                commit + ":refs/heads/main",
            ],
            token=repo["token"],
        )
        observed = git(
            fixture, ["ls-remote", remote, "refs/heads/main"], token=repo["token"]
        ).split()[0]
        if observed != commit:
            raise RuntimeError("Remote commit mismatch")
        result["tests"].append(
            "Binding-issued token publishes exact Git commit with expected-absent guard"
        )
        result["status"] = "passed"
    else:
        result["status"] = "cleaned"
except Exception as error:
    result["error"] = (
        str(error) if isinstance(error, RuntimeError) else type(error).__name__
    )
finally:
    failures = []
    if state["repo"]:
        try:
            worker("DELETE", "/repo")
            state["repo"] = False
            save()
        except Exception as error:
            failures.append(
                str(error) if isinstance(error, RuntimeError) else type(error).__name__
            )
    # Keep management capability if repo cleanup is unresolved; state is recovery intent.
    if state["worker"] and not state["repo"]:
        try:
            status, _ = request(
                "https://api.cloudflare.com/client/v4/accounts/"
                + args.account
                + "/workers/scripts/"
                + state["name"],
                credential,
                "DELETE",
            )
            if status not in [200, 204, 404]:
                raise RuntimeError("Worker cleanup HTTP " + str(status))
            state["worker"] = False
            save()
        except Exception as error:
            failures.append(
                str(error) if isinstance(error, RuntimeError) else type(error).__name__
            )
    if failures:
        result["status"] = "cleanup_failed"
    result.update(
        at=time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        credentialReference="env:" + args.credential_env,
        resourceName=state["name"],
        account=args.account,
        namespace="forge-runtime-cert",
        workerSha256=hashlib.sha256(source).hexdigest(),
        scope="Native Artifacts binding management and Git transport; not REST API authorization or full reader/journal certification",
        cleanup={
            "remainingResources": int(state["worker"]) + int(state["repo"]),
            "errors": failures,
        },
    )
    evidence = Path(args.evidence)
    evidence.parent.mkdir(parents=True, exist_ok=True)
    evidence.write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps(result, indent=2))
raise SystemExit(0 if result["status"] in ["passed", "cleaned"] else 1)
