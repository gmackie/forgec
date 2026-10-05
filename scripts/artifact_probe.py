"""Bounded transport qualification for read-only disposable Worker probes."""

import hashlib
import json
import re
import time


def probe(send, record, sleep=time.sleep):
    for attempt in range(5):
        status, payload = send()
        try:
            return status, json.loads(payload)
        except ValueError:
            match = re.fullmatch(rb"error code: (1042)\s*", payload)
            retry = match is not None and status in (404, 500) and attempt < 4
            if match:
                record(
                    {
                        "httpStatus": status,
                        "platformCode": int(match[1]),
                        "bodySha256": hashlib.sha256(payload).hexdigest(),
                        "attempt": attempt + 1,
                        "retry": retry,
                    }
                )
            if not retry:
                raise RuntimeError(
                    f"Qualification Worker returned non-JSON HTTP {status}; body SHA256 "
                    + hashlib.sha256(payload).hexdigest()
                ) from None
            sleep(2 * (attempt + 1))
