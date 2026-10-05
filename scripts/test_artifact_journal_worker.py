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
