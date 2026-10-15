# Releasing

Forgejo is the CI and release-verification authority for this repository. GitHub
is a source/distribution mirror only; no `.github/workflows` are active.

## Current beta gate

Source is at 0.5.0; the public npm SDKs were observed at 0.4.0 on 2026-10-15.
The retained release manifest does not certify the current required profiles.
Do not tag or publish from these facts alone. FORG-6 owns the release and current
provider certification; FORG-20 and FORGE-117 own package identity disambiguation.

## Verify before publishing

1. Land the intended source revision through exact-head Forgejo CI.
2. Run **Release rehearsal** in Forgejo. It verifies versions and SDK ownership,
   compiler tests, public package builds, tarball contents and crate-name ownership.
   It retains the revision, existing manifest and package ownership policy as
   artifacts. It never publishes and does not convert that manifest into new
   certification evidence.
3. Execute current-build certification for each advertised profile. Retain the
   source/runtime/build identity and raw reports. Generate and sign the release
   manifest after the required evidence is available; uncertified profiles remain
   explicit. The narrow transaction provider suite is not full profile certification.
4. Verify all nine npm names in `package-identities.json`, and public registry
   ownership with authenticated release credentials before publication. Offline
   identity checks establish repository ownership, not registry account permission.
5. Agree one new version across Cargo and publishable npm packages, update the
   changelog and re-run verification after version/lockfile changes. Install and
   test the packed artifacts outside the monorepo.

## Publication remains a separate delivery step

The old GitHub release/publish workflow has been removed. Its GitHub OIDC
provenance claim cannot be transferred to Forgejo: npm does not accept a Forgejo
runner as a GitHub provenance issuer. Public package metadata names the Forgejo
source and does not request unsupported npm provenance. Signed release evidence
must be described separately from npm provenance.

The new Forgejo workflow currently verifies only. FORG-6 remains open until the
credentialed npm/crates publication and release asset path is implemented and
verified. No tag push is advertised as an automatic publish trigger. Release
credentials belong in Forgejo secrets, never in source or shell output.

Publish immutable artifacts only from the verified revision with a confirmed
version. Crate publication is permanent: run `check-crate-names.mjs` first and
publish in dependency order. `publish-crates.mjs` supports retrying an existing
version, but its skip behavior does not prove that an existing artifact matches
this source. Verify registry checksums/source metadata rather than silently
accepting an already-used version.

## Verify the actual offering

Completion requires installing the compiler and runtime from their real public
artifacts, running init/check/build and an authenticated application roundtrip,
checking binary checksums and the signed manifest, and rehearsing migrations and
rollback. Validate any Homebrew formula against those release assets before
claiming it installs the new version. Source merge or successful rehearsal alone
is not release completion.

See [package ownership](package-ownership.md) and the
[public-beta plan](plans/2026-10-15-public-beta.html).
