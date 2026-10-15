"""Deploy an owned disposable journal Worker; caller records ownership first."""

from artifact_probe import probe
import time
import urllib.request
import urllib.error
import hashlib
import json
import secrets
import subprocess
import shlex
import base64


def http_client_config(config):
    """Never transfer account management or repository credentials to the HTTP client."""
    worker = config["journalWorker"]
    return {"journalWorker": {"url": worker["url"], "secret": worker["secret"]}}


def ready(send, record, sleep=time.sleep):
    status, payload = probe(send, record, sleep)
    if status != 405 or payload != {"code": "MethodNotAllowed"}:
        raise RuntimeError("Journal Worker readiness failed")


def deploy(
    root,
    state_dir,
    name,
    database,
    secret,
    api,
    record,
    *,
    entry="conformance/artifacts/journal-worker.ts",
    extra_bindings=(),
    runner_host=None,
):
    bundle = state_dir / "journal-worker.mjs"
    code = "const {createRequire}=require('node:module');const runtime=createRequire(process.argv[1]);const r=createRequire(runtime.resolve('wrangler/package.json'));r('esbuild').buildSync({entryPoints:[process.argv[2]],outfile:process.argv[3],bundle:true,format:'esm',platform:'browser',target:'es2022',conditions:['source']});"
    run = subprocess.run(
        [
            "node",
            "-e",
            code,
            str(root / "packages/runtime/package.json"),
            str(root / entry),
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
            *extra_bindings,
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
        if runner_host:
            code = """import sys,json,urllib.request,urllib.error,base64
x=json.load(sys.stdin)
r=urllib.request.Request(x['url'],headers={'Authorization':'Bearer '+x['secret'],'User-Agent':'Mozilla/5.0 ForgeArtifactQualification'})
try: response=urllib.request.urlopen(r,timeout=30)
except urllib.error.HTTPError as e: response=e
with response: print(json.dumps({'status':response.status,'body':base64.b64encode(response.read()).decode()}))
"""
            run = subprocess.run(
                [
                    "ssh",
                    "-o",
                    "BatchMode=yes",
                    runner_host,
                    "python3 -c " + shlex.quote(code),
                ],
                input=json.dumps({"url": url, "secret": secret}),
                capture_output=True,
                text=True,
                timeout=45,
            )
            if run.returncode:
                raise RuntimeError("Remote read-only Worker probe failed")
            value = json.loads(run.stdout)
            return value["status"], base64.b64decode(value["body"])
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
