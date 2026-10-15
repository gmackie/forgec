import unittest
from artifact_journal_worker import ready


class ReadinessTests(unittest.TestCase):
    def test_readiness_retries_platform_1042_without_journal_write(self):
        replies = iter(
            [(404, b"error code: 1042\n"), (405, b'{"code":"MethodNotAllowed"}')]
        )
        events = []
        ready(lambda: next(replies), events.append, lambda _: None)
        self.assertEqual(events[0]["platformCode"], 1042)

    def test_rejects_auth_and_application_errors(self):
        for status, payload in [
            (401, b'{"code":"Unauthenticated"}'),
            (500, b'{"code":"Internal"}'),
        ]:
            with self.assertRaisesRegex(RuntimeError, "readiness"):
                ready(
                    lambda: (status, payload),
                    lambda _: self.fail("retry"),
                    lambda _: None,
                )


class RemoteReadinessTests(unittest.TestCase):
    def test_http_client_receives_only_disposable_worker_capability(self):
        from artifact_journal_worker import http_client_config

        config = {
            "credential": "account-secret",
            "token": "repo-secret",
            "journalWorker": {
                "url": "https://fixture.workers.dev",
                "secret": "worker-secret",
                "extra": "private",
            },
        }
        self.assertEqual(
            http_client_config(config),
            {
                "journalWorker": {
                    "url": "https://fixture.workers.dev",
                    "secret": "worker-secret",
                }
            },
        )

    def test_remote_probe_keeps_secret_in_stdin_and_uses_no_ref_writes(self):
        import base64
        import json
        from pathlib import Path
        import subprocess
        import tempfile
        from unittest.mock import patch
        from artifact_journal_worker import deploy

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            calls = []

            def run(argv, **kwargs):
                calls.append((argv, kwargs))
                if argv[0] == "node":
                    Path(argv[-1]).write_text("export default {}")
                    return subprocess.CompletedProcess(argv, 0)
                self.assertEqual(
                    argv[:4], ["ssh", "-o", "BatchMode=yes", "fixture-host"]
                )
                self.assertNotIn("private-secret", " ".join(argv))
                config = json.loads(kwargs["input"])
                self.assertEqual(config["secret"], "private-secret")
                self.assertTrue(config["url"].endswith(".workers.dev"))
                # The deployed readiness probe issues a GET with no body.
                self.assertNotIn('method="POST"', argv[-1])
                return subprocess.CompletedProcess(
                    argv,
                    0,
                    stdout=json.dumps(
                        {
                            "status": 405,
                            "body": base64.b64encode(
                                b'{"code":"MethodNotAllowed"}'
                            ).decode(),
                        }
                    ),
                )

            def api(path, *args, **kwargs):
                return {"subdomain": "fixture"} if path == "/workers/subdomain" else {}

            with patch("artifact_journal_worker.subprocess.run", side_effect=run):
                config, digest = deploy(
                    root,
                    root,
                    "owned-fixture",
                    "db",
                    "private-secret",
                    api,
                    lambda _: None,
                    runner_host="fixture-host",
                )
            self.assertEqual(len(calls), 2)
            self.assertEqual(config["secret"], "private-secret")
            self.assertEqual(len(digest), 64)
