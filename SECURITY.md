# Security policy

Report vulnerabilities privately to the maintainers (repository owner on
git.forgegraf.com); do not open a public issue. We acknowledge within 3 business
days and coordinate a fix and disclosure.

Scope notes:
- `FORGE_AUTH=dev-headers` trusts request headers and is for development only.
- Admin operations (`/v1/admin/*`) and signal endpoints must sit behind the
  deployment's `AuthHost`; they are operator-only by intent.
- Secrets never enter the bundle or generated sources.
