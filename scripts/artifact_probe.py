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
            platform = re.fullmatch(rb"error code: ([0-9]+)\s*", payload)
            match = (
                platform if platform is not None and platform[1] == b"1042" else None
            )
            retry = match is not None and status in (404, 500) and attempt < 4
            if platform:
                record(
                    {
                        "httpStatus": status,
                        "platformCode": int(platform[1]),
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
