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
| `crates` | `scripts/publish-crates.mjs`: `forge-syntax → forge-semantic → forge-planner → forge-codegen → forgegraph-cli`, waiting for the crates.io index between each so the next crate can resolve the last. Also skips versions that are already up. |
| `homebrew` | `scripts/update-homebrew-tap.mjs` renders `Formula/forgec.rb` from the release artifacts and pushes it to `gmackorg/homebrew-tap`. |

Every job is idempotent per version. Re-running a failed release does not
double-publish.

## Required secrets

Set these on the GitHub repository (Settings → Secrets and variables →
Actions):

| secret | used by | how to get it |
| --- | --- | --- |
| `NPM_TOKEN` | `npm` | An npm **automation** token for an account with publish rights on the `@forgegraph` scope. Granular tokens work; classic "publish" tokens also work. Provenance additionally requires the workflow's OIDC token, which is granted in the workflow itself (`id-token: write`) and needs no secret. |
| `CARGO_REGISTRY_TOKEN` | `crates` | A crates.io API token scoped to `publish-update` (and `publish-new` for the first release of each crate). |
| `HOMEBREW_TAP_TOKEN` | `homebrew` | A fine-grained PAT with **Contents: read and write** on `gmackorg/homebrew-tap` only. The default `GITHUB_TOKEN` cannot push to another repository. |

`GITHUB_TOKEN` covers the GitHub release itself; nothing extra is needed for it.

## Bootstrapping the Homebrew tap

The tap is shared by every CLI we publish, so this is done once, not once per
project. It already exists: **https://github.com/gmackorg/homebrew-tap**.

If you ever need to recreate it, or set one up for another org:

1. Create a public repository named **`homebrew-tap`**. The `homebrew-` prefix
   is what makes `brew install <owner>/tap/<formula>` resolve; users never type
   the prefix.
2. Give it a `README.md` and a `Formula/` directory. Nothing else is needed —
   the release job creates `Formula/<name>.rb` on first publish.
3. Mint the fine-grained PAT described above and add it as
   `HOMEBREW_TAP_TOKEN` to every repository that publishes a CLI.

`scripts/update-homebrew-tap.mjs` is deliberately generic and driven entirely
by environment variables, so it can be copied unchanged into any other CLI
repository:

```yaml
- run: node scripts/update-homebrew-tap.mjs
  env:
    FORMULA: my-cli                       # formula name == binary name
    VERSION: ${{ needs.verify.outputs.version }}
    REPO: ${{ github.repository }}        # where the release assets live
    TAP_REPO: gmackorg/homebrew-tap
    TAP_TOKEN: ${{ secrets.HOMEBREW_TAP_TOKEN }}
    DIST_DIR: dist                        # holds <name>-<version>-<target>.tar.gz(.sha256)
```

It expects artifacts named `<FORMULA>-<VERSION>-<rust target triple>.tar.gz`
with a sibling `.sha256`, and refuses to emit a formula for an artifact with no
checksum. Platforms with no artifact are omitted from the formula rather than
guessed at.

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
