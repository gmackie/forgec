import unittest
from artifact_probe import probe


class ProbeTests(unittest.TestCase):
    def test_platform_error_is_recorded_and_retried(self):
        responses = iter([(404, b"error code: 1042\n"), (200, b'{"ok":true}')])
        events = []
        sleeps = []
        self.assertEqual(
            probe(lambda: next(responses), events.append, sleeps.append),
            (200, {"ok": True}),
        )
        self.assertEqual(events[0]["platformCode"], 1042)
        self.assertEqual(events[0]["httpStatus"], 404)
        self.assertEqual(sleeps, [2])

    def test_application_failure_is_not_retried(self):
        self.assertEqual(
            probe(
                lambda: (500, b'{"code":"Internal"}'),
                lambda _: self.fail("retry"),
                lambda _: None,
            ),
            (500, {"code": "Internal"}),
        )

    def test_unknown_non_json_failure_is_not_retried(self):
        with self.assertRaisesRegex(RuntimeError, "non-JSON HTTP 500"):
            probe(
                lambda: (500, b"unknown"), lambda _: self.fail("retry"), lambda _: None
            )

    def test_retry_budget_is_finite(self):
        events = []
        with self.assertRaisesRegex(RuntimeError, "non-JSON HTTP 404"):
            probe(lambda: (404, b"error code: 1042\n"), events.append, lambda _: None)
        self.assertEqual(len(events), 5)
        self.assertFalse(events[-1]["retry"])


if __name__ == "__main__":
    unittest.main()
