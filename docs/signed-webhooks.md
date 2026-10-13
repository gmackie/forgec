# Signed webhooks

`createHttpHandler`, `createNodeHost` and `createWorker` accept an explicit
`webhooks` map. Each entry binds one exact path to POST requests authenticated
by HMAC-SHA256 over the original body bytes. Other methods, sibling paths and
normal domain/discovery endpoints still pass through the configured `AuthHost`.
A real `AuthHost` remains required by the hosts; webhook configuration does not
turn the rest of the application into an anonymous API.

```ts
const options = {
  auth: sessionAuth,
  webhooks: {
    "/hooks/forgejo": {
      secret: async () => privateSecrets.read("forgejo-webhook"),
      signatureHeader: "x-hub-signature-256",
      maxBodyBytes: 1024 * 1024,
      handle: async (request, rawBody, requestId) => {
        // Bytes have been verified. Read headers from request, body from rawBody.
        return inbox.persist(request.headers, rawBody, requestId);
      },
    },
  },
};
```

`createWorker` also accepts `webhooks: env => ({ ... })` so a secret resolver
can read a private Workers binding from `env` at request time. A signed callback
does not run the automatic domain outbox sweep from caller-supplied tenant headers.

Supply these options alongside the normal bundle/storage configuration of your
host. `sessionAuth`, `privateSecrets` and `inbox` are application-owned adapters,
not runtime globals. The secret resolver runs on every request so rotation
needs no process restart. Secrets must encode to at least 32 UTF-8 bytes.
The signature must be `sha256=` followed by 64 hex digits; configure the header
name for the sender's protocol. Verification uses Web Crypto, including on
Workers; it does not import Node crypto or shell out.

The reader counts bytes while streaming, rejects over-limit bodies with 413,
and cancels the remaining input. The default cap is 1 MiB. No JSON parse or
normalization happens before verification. Callbacks receive the unchanged
bytes; the Request body has already been consumed. Missing/invalid signatures
return 401; unavailable keys return a redacted 503. Callback exceptions return
a redacted 500, allowing the sender to retry. No domain tenant/actor is created
from a signature or payload.

A valid signature authenticates a sender, not event freshness. Consumers must
validate event schemas and resource mappings, durably deduplicate delivery IDs,
and handle replay, ordering and retries before applying effects. This boundary
does not provide a webhook inbox, a scheduler or a delivery receipt. Keep this
configuration private and use distinct keys per sender/integration.
