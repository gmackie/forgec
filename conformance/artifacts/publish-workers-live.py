"""Separate Worker invocations exercise the native publication path, without Git."""

import json
import sys
import urllib.request
import urllib.error

config = json.load(sys.stdin)
tests = []
diagnostics = []


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


opener = urllib.request.build_opener(NoRedirect)


def send(action, key, expected, status=200):
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
        body = json.loads(raw)
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
    lost = send("lost", "lost", first["head"])
    assert lost["receipt"]["outcome"] == "pending" and lost["posts"] == 1
    assert lost["head"] == lost["receipt"]["intent"]["revision"]["oid"]
    recovered = send("recover", "lost", first["head"])
    assert recovered["receipt"]["outcome"] == "observed" and recovered["posts"] == 0
    repeated = send("publish", "lost", first["head"])
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
