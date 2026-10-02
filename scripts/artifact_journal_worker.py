"""Deploy an owned disposable journal Worker; caller records ownership first."""

from artifact_probe import probe
import time
import urllib.request
import urllib.error
import hashlib
import json
import secrets
import subprocess


def ready(send, record, sleep=time.sleep):
    status, payload = probe(send, record, sleep)
    if status != 405 or payload != {"code": "MethodNotAllowed"}:
        raise RuntimeError("Journal Worker readiness failed")


def deploy(root, state_dir, name, database, secret, api, record):
    bundle = state_dir / "journal-worker.mjs"
    code = "const {createRequire}=require('node:module');const r=createRequire(process.argv[1]);r('esbuild').buildSync({entryPoints:[process.argv[2]],outfile:process.argv[3],bundle:true,format:'esm',platform:'browser',target:'es2022',conditions:['source']});"
    run = subprocess.run(
        [
            "node",
            "-e",
            code,
            str(root / "examples/acme/package.json"),
            str(root / "conformance/artifacts/journal-worker.ts"),
            str(bundle),
        ],
        capture_output=True,
    )
    if run.returncode:
        raise RuntimeError("Journal Worker bundle failed")
    source = bundle.read_bytes()
    metadata = {
        "main_module": "worker.mjs",
        "compatibility_date": "2026-10-01",
        "bindings": [
            {"name": "DB", "type": "d1", "id": database},
            {"name": "QUALIFICATION_SECRET", "type": "secret_text", "text": secret},
        ],
    }
    boundary = "forge" + secrets.token_hex(12)
    parts = []
    for name_part, mime, content in [
        ("metadata", "application/json", json.dumps(metadata).encode()),
        ("worker.mjs", "application/javascript+module", source),
    ]:
        parts.append(
            f'--{boundary}\r\nContent-Disposition: form-data; name="{name_part}"; filename="{name_part}"\r\nContent-Type: {mime}\r\n\r\n'.encode()
            + content
            + b"\r\n"
        )
    payload = b"".join(parts) + f"--{boundary}--\r\n".encode()
    api(
        "/workers/scripts/" + name,
        "PUT",
        raw=payload,
        content_type="multipart/form-data; boundary=" + boundary,
    )
    api("/workers/scripts/" + name + "/subdomain", "POST", {"enabled": True})
    subdomain = api("/workers/subdomain")["subdomain"]
    url = "https://" + name + "." + subdomain + ".workers.dev"

    def send():
        request = urllib.request.Request(
            url,
            headers={
                "Authorization": "Bearer " + secret,
                "User-Agent": "Mozilla/5.0 ForgeArtifactQualification",
            },
        )
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                return response.status, response.read()
        except urllib.error.HTTPError as error:
            return error.code, error.read()

    # GET authenticates and returns 405 before accessing D1. Only this read-only
    # readiness probe retries documented platform responses; journal writes never retry.
    ready(send, record)
    return {"url": url, "secret": secret}, hashlib.sha256(source).hexdigest()
