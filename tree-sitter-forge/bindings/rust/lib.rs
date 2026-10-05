//! Editor-local syntax. Rowan and forgegraph-semantic remain authoritative.
use tree_sitter_language::LanguageFn;
unsafe extern "C" {
    fn tree_sitter_forge() -> *const ();
}
/// Load with `parser.set_language(&LANGUAGE.into())`.
pub const LANGUAGE: LanguageFn = unsafe { LanguageFn::from_raw(tree_sitter_forge) };
pub const NODE_TYPES: &str = include_str!("../../src/node-types.json");
pub const HIGHLIGHTS: &str = include_str!("../../queries/highlights.scm");
pub const FOLDS: &str = include_str!("../../queries/folds.scm");
pub const INDENTS: &str = include_str!("../../queries/indents.scm");
pub const LOCALS: &str = include_str!("../../queries/locals.scm");
pub const TAGS: &str = include_str!("../../queries/tags.scm");
#[cfg(test)]
mod tests;
