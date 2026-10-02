"""Failure-path checks for the disposable Turso resource lifecycle."""

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
from urllib.error import URLError

SCRIPT = Path(__file__).with_name("qualify-turso.py")


class TursoLifecycleTests(unittest.TestCase):
    def invoke(
        self,
        root,
        organization="gmackie",
        cleanup=False,
        owned=True,
        database="forge-cert-0123456789abcdef",
    ):
        state = root / "state"
        state.mkdir()
        (state / "state.json").write_text(
            json.dumps(
                {"organization": organization, "database": database, "owned": owned}
            )
        )
        evidence = root / "reports" / "result.json"
        argv = [
            str(SCRIPT),
            "--organization",
            organization,
            "--state-dir",
            str(state),
            "--evidence",
            str(evidence),
        ]
        if cleanup:
            argv.append("--cleanup-only")
        with (
            patch.dict(os.environ, {"TURSO_API_KEY": "fixture-secret"}),
            patch.object(sys, "argv", argv),
            patch(
                "urllib.request.urlopen", side_effect=URLError("fixture-secret")
            ) as api,
            contextlib.redirect_stdout(io.StringIO()),
        ):
            try:
                runpy.run_path(str(SCRIPT), run_name="__main__")
            except SystemExit:
                pass
        return api, evidence, json.loads((state / "state.json").read_text())

    def test_existing_owned_database_requires_explicit_cleanup(self):
        with tempfile.TemporaryDirectory() as d:
            api, _, state = self.invoke(Path(d))
            api.assert_not_called()
            self.assertTrue(state["owned"])

    def test_cleanup_network_failure_retains_owned_intent_and_evidence(self):
        with tempfile.TemporaryDirectory() as d:
            api, evidence, state = self.invoke(Path(d), cleanup=True)
            self.assertEqual(api.call_count, 1)
            self.assertTrue(state["owned"])
            result = json.loads(evidence.read_text())
            self.assertEqual(result["status"], "cleanup_failed")
            self.assertEqual(result["cleanup"]["remainingDatabases"], 1)
            self.assertNotIn("fixture-secret", evidence.read_text())

    def test_invalid_organization_never_reaches_management_api(self):
        with tempfile.TemporaryDirectory() as d:
            api, _, _ = self.invoke(Path(d), organization="../other", cleanup=True)
            api.assert_not_called()

    def test_unowned_database_name_is_rejected(self):
        with tempfile.TemporaryDirectory() as d:
            api, _, _ = self.invoke(Path(d), database="production", cleanup=True)
            api.assert_not_called()


if __name__ == "__main__":
    unittest.main()
