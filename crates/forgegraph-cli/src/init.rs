//! A compiler-only starter: no credentials, provider provisioning or package-manager hooks.
use anyhow::{Context, Result, bail};
use std::io::Write;
use std::path::Path;

fn valid_component(value: &str) -> bool {
    !value.is_empty()
        && value.as_bytes()[0].is_ascii_lowercase()
        && value
            .bytes()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-')
}

fn valid_name(name: &str) -> bool {
    let Some((scope, package)) = name.strip_prefix('@').and_then(|s| s.split_once('/')) else {
        return false;
    };
    valid_component(scope) && valid_component(package)
}

pub fn create(path: &Path, name: Option<&str>) -> Result<()> {
    let inferred;
    let name = match name {
        Some(name) => name,
        None => {
            let directory = path.file_name().and_then(|s| s.to_str()).unwrap_or("");
            inferred = format!("@local/{directory}");
            &inferred
        }
    };
    if !valid_name(name) {
        bail!(
            "package name must be @scope/name with lowercase letters, digits and hyphens; each component must start with a letter (use --name)"
        );
    }
    // create_dir is deliberately exclusive: even an empty directory or a dangling
    // symlink must not become an overwrite target. Parent directories must exist.
    std::fs::create_dir(path).with_context(|| {
        format!(
            "cannot create {}: choose a new directory with an existing parent",
            path.display()
        )
    })?;
    let manifest = format!(
        "[package]\nname = \"{name}\"\nversion = \"0.1.0\"\nedition = \"2026\"\n\n[source]\nroot = \"src\"\nentry = \"src/index.forge\"\n\n[compatibility]\nprofile = \"portable-v1\"\ntargets = [\"cloudflare-d1\", \"aws-dynamodb\"]\n"
    );
    let readme = format!(
        "# {name}\n\nA dependency-free Forge language starter. Requires `forgec` on PATH.\n\nFrom this directory:\n\n```sh\nforgec check .\nforgec fmt --check .\nforgec build .\n```\n\nEdit `src/index.forge`, then repeat those commands. `generated/` contains the\napplication bundle, SQL migrations, typed client, OpenAPI and contract artifacts.\nThis starter compiles locally without credentials or cloud resources. Building\ndoes not start a server, apply migrations or deploy an application.\n\nTo run the bundle, install the matching `@forgegraph/runtime` release, choose a\nhost and storage adapter, and supply a real AuthHost before exposing it publicly.\nSee https://git.forgegraf.com/gmackie/forge/src/branch/main/docs/getting-started.md\nfor host configuration and the reference application.\n"
    );
    std::fs::create_dir(path.join("src"))?;
    for (file, content) in [
        ("forge.toml", manifest.as_str()),
        (
            "src/index.forge",
            "export resource Task\n  @crud(\"/v1/tasks\")\n{\n  id : id\n  title : text\n}\n",
        ),
        ("README.md", readme.as_str()),
        (
            ".gitignore",
            "/generated/\n/node_modules/\n/.wrangler/\n/.env\n/.env.*\n/.dev.vars\n",
        ),
    ] {
        let mut output = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(path.join(file))?;
        output.write_all(content.as_bytes())?;
    }
    println!("Created {name} in {}", path.display());
    println!(
        "Next: change into that directory, then run forgec check ., forgec fmt --check . and forgec build ."
    );
    Ok(())
}
