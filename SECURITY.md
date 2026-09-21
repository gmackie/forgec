# Security policy

## Reporting a vulnerability

Report privately through
[GitHub Security Advisories](https://github.com/gmackorg/forgegraph/security/advisories/new),
or by email to **security@forgegraf.com**. Do not open a public issue, a
discussion, or a pull request that demonstrates the problem.

Please include the affected version, what an attacker gains, and a
reproduction — a cut-down `.forge` package and the commands you ran is ideal.

You will get an acknowledgement within **3 business days**. We will tell you
our assessment of severity and our intended fix window, and we will keep you
updated at least weekly until it is closed. We coordinate disclosure with you
and credit you in the advisory unless you ask us not to.

## Supported versions

ForgeGraph is 0.x. Only the latest minor receives security fixes. There is no
long-term support branch; the fix ships in the next patch of the current minor.

## What is in scope

- The compiler (`forgec`, the `forge-*` crates): anything that makes a compiled
  bundle disagree with its source in a way that weakens a policy, a capability
  or a data classification.
- The runtime (`@forgegraph/runtime` and the host adapters): authentication,
  authorization, tenant isolation, purpose scoping, the suppression ledger,
  optimistic concurrency, and the outbox.
- Generated artifacts: a generated client, OpenAPI document or migration that
  exposes more than the source declared.
- The registry and grant flow (`@forgegraph/registry`): signature verification,
  artifact immutability, and grant activation.
- Supply chain: the release workflow, the published tarballs, and the Homebrew
  formula.

## What is out of scope

These are documented behaviours, not vulnerabilities:

- **`FORGE_AUTH=dev-headers`.** It trusts `x-forge-tenant` and `x-forge-actor`
  from the request. It exists for local development, must be opted into by
  name, and logs a warning on every start. Every host refuses to start with no
  `AuthHost` at all rather than falling back to it.
- **Admin and signal endpoints** (`/v1/admin/*`, workflow signals). They are
  operator-only by intent and must sit behind the deployment's `AuthHost`;
  exposing them publicly is a deployment error.
- **The example application** (`examples/acme`) and the conformance suite. They
  are configured for demonstration, including dev-header auth, and are not
  meant to be deployed as-is.
- Anything requiring an attacker who already holds the deployment's signing
  keys, database credentials, or cloud account.
- Findings from an automated scanner with no demonstrated impact.

## Hardening notes for deployments

- Configure a real `AuthHost` (`jwtAuth` or your own) in every environment,
  including staging. Never set `FORGE_AUTH=dev-headers` anywhere a real
  credential could reach.
- Secrets never enter a bundle or a generated source file. If you find one
  there, that is in scope and we want to hear about it.
- Verify release artifacts against the published SHA-256 sums, and check the
  npm provenance attestation on `@forgegraph/*` packages.
- `forgec compat` before a cutover: a policy or capability change classified as
  `breaking` is exactly the change most likely to open a hole.
