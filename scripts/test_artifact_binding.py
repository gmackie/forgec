"""No retries or premature Worker deletion after uncertain repository creation."""

import contextlib
import io
import json
import os
from pathlib import Path
import runpy
import sys
import tempfile
import unittest
from unittest.mock import patch
from urllib.error import HTTPError

SCRIPT = Path(__file__).with_name("qualify-artifact-binding.py")
ACCOUNT = "a" * 32


class Reply:
    status = 200

    def __init__(self, value):
        self.value = value

    def __enter__(self):
        return self

    def __exit__(self, *args):
        pass

    def read(self):
        return json.dumps(self.value).encode()


class BindingLifecycleTests(unittest.TestCase):
    def invoke(self, root, delete_status, owned=False):
        state = root / "private"
        state.mkdir()
        if owned:
            (state / "state.json").write_text(
                json.dumps(
                    {
                        "account": ACCOUNT,
                        "name": "forge-binding-" + "b" * 16,
                        "secret": "fixture-secret",
                        "worker": True,
                        "repo": True,
                    }
                )
            )
        evidence = root / "evidence.json"
        calls = []

        def opened(req, timeout):
            method = req.get_method()
            url = req.full_url
            calls.append((method, url))
            if url.endswith("/ready"):
                return Reply({"ready": True})
            if url.endswith("/create"):
                raise HTTPError(url, 500, "fixture", {}, io.BytesIO(b"{}"))
            if url.endswith("/repo") and method == "DELETE":
                raise HTTPError(url, delete_status, "fixture", {}, io.BytesIO(b"{}"))
            if url.endswith("/workers/subdomain"):
                return Reply(
                    {"success": True, "result": {"subdomain": "qualification"}}
                )
            return Reply({"success": True, "result": {}})

        argv = [
            str(SCRIPT),
            "--account",
            ACCOUNT,
            "--state-dir",
            str(state),
            "--evidence",
            str(evidence),
        ]
        with (
            patch.dict(
                os.environ, {"CF_ARTIFACT_CERT_TOKEN": "fixture-management-secret"}
            ),
            patch.object(sys, "argv", argv),
            patch("urllib.request.build_opener") as factory,
            contextlib.redirect_stdout(io.StringIO()),
        ):
            factory.return_value.open.side_effect = opened
            with self.assertRaises(SystemExit):
                runpy.run_path(str(SCRIPT), run_name="__main__")
        return (
            calls,
            json.loads(evidence.read_text()) if evidence.exists() else None,
            json.loads((state / "state.json").read_text()),
        )

    def test_uncertain_create_is_not_retried_and_failed_cleanup_retains_worker(self):
        with tempfile.TemporaryDirectory() as d:
            calls, result, state = self.invoke(Path(d), 503)
            self.assertEqual(sum(url.endswith("/create") for _, url in calls), 1)
            self.assertFalse(
                any(
                    method == "DELETE" and "/workers/scripts/" in url
                    for method, url in calls
                )
            )
            self.assertTrue(state["repo"] and state["worker"])
            self.assertEqual(result["cleanup"]["remainingResources"], 2)
            self.assertNotIn("fixture-management-secret", json.dumps(result))

    def test_confirmed_absence_allows_worker_cleanup(self):
        with tempfile.TemporaryDirectory() as d:
            calls, result, state = self.invoke(Path(d), 404)
            self.assertTrue(
                any(
                    method == "DELETE" and "/workers/scripts/" in url
                    for method, url in calls
                )
            )
            self.assertEqual(result["cleanup"]["remainingResources"], 0)
            self.assertEqual(result["status"], "failed")

    def test_owned_state_refused_before_network(self):
        with tempfile.TemporaryDirectory() as d:
            calls, result, state = self.invoke(Path(d), 404, owned=True)
            self.assertEqual(calls, [])
            self.assertTrue(state["repo"] and state["worker"])


if __name__ == "__main__":
    unittest.main()
