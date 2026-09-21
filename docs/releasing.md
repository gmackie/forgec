# Releasing

One version number covers everything: the Rust workspace, every crate, every
npm package. A release is a tag; the tag is the only manual step.

## The flow

1. Land everything for the release on `main` and let CI go green.
2. Update `CHANGELOG.md`: rename the `## Unreleased` section to
   `## <version> (<date>)`. The release job reads this section verbatim as the
   GitHub release body, so a missing section fails the release rather than
   publishing an empty one.
3. Bump the version in `Cargo.toml` (`[workspace.package]`) and in every
   publishable `package.json`. They must agree with the tag exactly —
   `scripts/check-release-version.mjs` compares all of them and fails the
   release on any disagreement.
4. Regenerate the release manifest: `pnpm release:manifest`.
5. Commit, then tag and push:

   ```sh
   git tag -a v0.3.0 -m "v0.3.0"
   git push origin v0.3.0
   ```

Everything after that is `.github/workflows/release.yml`. To rehearse without
publishing anything, run the workflow manually from the Actions tab with
**dry run** left on: it builds every binary, runs `cargo publish --dry-run`,
`pnpm publish --dry-run` and renders the Homebrew formula without pushing.

## What the workflow does

| job | what it produces |
| --- | --- |
| `verify` | Version agreement, the full Rust and JS suites against PostgreSQL 17, and `check-packaging.mjs` (every tarball carries its built `dist`, README and LICENSE). |
| `binaries` | `forgec` for `aarch64`/`x86_64` × macOS/Linux, tarred as `forgec-<version>-<target>.tar.gz` with a sibling `.sha256`. |
| `github-release` | The GitHub release, with the binaries, their checksums and `RELEASE_MANIFEST.json` attached. |
| `npm` | `pnpm -r publish` with [provenance](https://docs.npmjs.com/generating-provenance-statements). Already-published versions are skipped, so a re-run after a partial failure completes rather than fails. |
| `crates` | `scripts/publish-crates.mjs`: `forgegraph-syntax → forgegraph-semantic → forgegraph-planner → forgegraph-codegen → forgegraph-cli`, waiting for the crates.io index between each so the next crate can resolve the last. Also skips versions that are already up. |

The Homebrew formula is **not** produced here. `gmackorg/homebrew-tap` pulls it
from the release — see "The Homebrew tap" below.

Every job is idempotent per version. Re-running a failed release does not
double-publish.

## Required secrets

Set these on the GitHub repository (Settings → Secrets and variables →
Actions):

| secret | used by | how to get it |
| --- | --- | --- |
| `NPM_TOKEN` | `npm` | An npm **automation** token for an account with publish rights on the `@forgegraph` scope. Granular tokens work; classic "publish" tokens also work. Provenance additionally requires the workflow's OIDC token, which is granted in the workflow itself (`id-token: write`) and needs no secret. |
| `CARGO_REGISTRY_TOKEN` | `crates` | A crates.io API token scoped to `publish-update` (and `publish-new` for the first release of each crate). |

`GITHUB_TOKEN` covers the GitHub release itself; nothing extra is needed for it.
There is deliberately **no Homebrew secret**: the tap pulls rather than being
pushed to.

## The Homebrew tap

The tap is **https://github.com/gmackorg/homebrew-tap**, shared by every CLI we
publish. It pulls; this repository does not push to it.

`bin/sync-formulae.mjs` runs there on a schedule (and on demand via the **Sync
formulae** workflow), reads `tap.json`, and regenerates each formula from the
latest GitHub release of the project that produces it. Checksums come from the
`.sha256` files the release published — computed on the machine that built the
binary, never recomputed from a download.

This direction is deliberate. Pushing would require a credential that can write
to the tap from *this* repository: a personal access token or a deploy key,
held by every project we publish, rotated in every project, and able to do more
than the one thing it is for. Pulling requires nothing — a workflow in the tap
already has write access to the tap, and a public release is readable without
auth. (Deploy keys are also disabled across `gmackorg`, which is a sensible
policy and one this design does not ask anyone to change.)

The cost is latency: a formula appears within the schedule interval rather than
the instant the release finishes. Run **Sync formulae** manually when you do
not want to wait.

### Adding another CLI to the tap

Add four lines to `tap.json` in the tap repository:

```json
{ "name": "mytool", "repo": "owner/repo", "desc": "what it does", "license": "Apache-2.0" }
```

The project's release must tag as `v<semver>` and attach
`mytool-<version>-<rust target triple>.tar.gz` with a sibling `.sha256` for
each platform it supports. Platforms with no published checksum are left out of
the formula rather than guessed at. Nothing else is required of the project —
in particular, no secret.

Verify a published formula the way a user would:

```sh
brew update && brew install gmackorg/tap/forgec && forgec --version
```

## If the repository moves

npm provenance attests that a package was built by a specific workflow in a
specific repository, and npm rejects a publish whose `repository.url` names a
different one. So the URL in the metadata is not decoration: it must be the
repository the release workflow actually runs in.

Moving the project is therefore one commit, made *before* the tag:

```sh
grep -rl 'gmackie/forgec' . --exclude-dir node_modules --exclude-dir target \
  | xargs perl -pi -e 's{gmackie/forgec}{<new-owner>/<new-repo>}g'
pnpm release:manifest && pnpm lint:workflows
```

Then move the three secrets to the new repository and re-point the `Mirror to
Forgejo` remote if it changed. The mirror job deliberately has no
repository-name guard, so it keeps working across a move.

## Publishing a crate for the first time

crates.io reserves a name on first publish, and the first publish of each crate
must come from an account with `publish-new` rights. If a new crate joins the
workspace, publish it once by hand (`cargo publish -p <crate>`) before the first
tagged release that includes it; after that the release job takes over.

## After the release

- Add a fresh `## Unreleased` heading to `CHANGELOG.md`.
- Check that the tap formula installs (`brew install gmackorg/tap/forgec`) and
  that npm shows the provenance badge on `@forgegraph/runtime`.
- The Forgejo mirror at `git.forgegraf.com/gmackie/forge` syncs from `main` and
  from tags; it is a mirror, not a publish target.
