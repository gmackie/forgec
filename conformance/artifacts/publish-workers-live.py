"""Separate Worker invocations exercise the native publication path, without Git."""

import concurrent.futures
import json
import sys
import hashlib
import re
import time
import urllib.request
import urllib.error

config = json.load(sys.stdin)
tests = []
diagnostics = []


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


opener = urllib.request.build_opener(NoRedirect)


def send(action, key, expected, status=200, attempt=0):
    request = urllib.request.Request(
        config["journalWorker"]["url"],
        method="POST",
        headers={
            "Authorization": "Bearer " + config["journalWorker"]["secret"],
            "Content-Type": "application/json",
            "User-Agent": "Mozilla/5.0 ForgeArtifactQualification",
        },
        data=json.dumps(dict(action=action, key=key, expected=expected)).encode(),
    )
    try:
        response = opener.open(request, timeout=60)
    except urllib.error.HTTPError as error:
        response = error
    with response:
        raw = response.read()
        diagnostic = dict(action=action, status=response.code)
        diagnostics.append(diagnostic)
        try:
            body = json.loads(raw)
        except ValueError:
            match = re.fullmatch(rb"error code: ([0-9]+)\s*", raw)
            diagnostic.update(
                bodySha256=hashlib.sha256(raw).hexdigest(),
                platformCode=int(match[1]) if match else None,
            )
            # Only retry provider-read-only reconciliation/denial probes on the
            # documented transient routing code. Never retry a publication POST.
            if (
                action in ("recover", "denied", "foreign")
                and match
                and match[1] == b"1042"
                and response.code in (404, 500)
                and attempt < 4
            ):
                time.sleep(2 * (attempt + 1))
                return send(action, key, expected, status, attempt + 1)
            raise

        diagnostic.update({k: body[k] for k in ("stage", "transport") if k in body})
        if "receipt" in body:
            diagnostic["outcome"] = body["receipt"]["outcome"]
            diagnostic.update(
                head=body.get("head"),
                oid=body["receipt"]["intent"]["revision"]["oid"],
                posts=body.get("posts"),
                binary=body.get("binary"),
            )
        assert response.code == status, "Worker response status"
        return body


try:
    first = send("publish", "first", None)
    assert first["receipt"]["outcome"] == "accepted"
    assert first["posts"] == 1
    assert first["head"] == first["receipt"]["intent"]["revision"]["oid"]
    assert first["binary"] == [0, 255, 128]
    tests.append(
        {
            "name": "Worker prepares and publishes binary Git pack with native Artifacts identity and D1 receipt"
        }
    )
    replay = send("publish", "first", None)
    assert replay["receipt"]["outcome"] == "accepted" and replay["posts"] == 0
    tests.append({"name": "Separate invocation replays durable receipt without a POST"})
    stale = send("publish", "stale", None)
    assert stale["receipt"]["outcome"] == "rejected" and stale["posts"] == 0
    tests.append({"name": "Stale expected-absent request rejected without dispatch"})
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        races = list(
            pool.map(
                lambda key: send("publish", key, first["head"]), ["race-a", "race-b"]
            )
        )
    assert sorted(r["receipt"]["outcome"] for r in races) == ["accepted", "rejected"]
    winner = next(r for r in races if r["receipt"]["outcome"] == "accepted")
    current = winner["receipt"]["intent"]["revision"]["oid"]
    tests.append(
        {
            "name": "Competing independent Worker requests admit exactly one expected-head writer"
        }
    )
    lost = send("lost", "lost", current)
    assert lost["receipt"]["outcome"] == "pending" and lost["posts"] == 1
    assert lost["head"] == lost["receipt"]["intent"]["revision"]["oid"]
    recovered = send("recover", "lost", current)
    assert recovered["receipt"]["outcome"] == "observed" and recovered["posts"] == 0
    repeated = send("publish", "lost", current)
    assert repeated["receipt"]["outcome"] == "observed" and repeated["posts"] == 0
    tests.append(
        {
            "name": "Lost acknowledgement remains pending then reconciles observed without resending"
        }
    )
    claimed = send("claim", "claimed", lost["head"])
    assert claimed["receipt"]["outcome"] == "pending" and claimed["posts"] == 0
    interrupted = send("recover", "claimed", lost["head"])
    assert interrupted["receipt"]["outcome"] == "pending" and interrupted["posts"] == 0
    tests.append(
        {"name": "Claim-before-dispatch interruption remains pending without takeover"}
    )
    assert send("denied", "denied", lost["head"], 403)["code"] == "NotPermitted"
    assert send("foreign", "foreign", lost["head"], 403)["code"] == "NotPermitted"
    tests.append({"name": "Authorization and cross-tenant denial"})
    print(json.dumps(dict(status="passed", tests=tests)))
except Exception:
    print(
        json.dumps(
            dict(
                status="failed",
                tests=tests,
                diagnostics=diagnostics,
                error="Workers publication qualification failed",
            )
        )
    )
    sys.exit(1)
