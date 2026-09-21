//! Browser bridge for the real Forge parser and compiler. No filesystem or network access.

use forgegraph_semantic::{Package, compile};
use forgegraph_syntax::SyntaxNode;
use serde::Deserialize;
use serde_json::{Value, json};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Input {
    name: String,
    current_file: String,
    files: Vec<File>,
}
#[derive(Deserialize)]
struct File {
    path: String,
    text: String,
}

fn utf16_offsets(text: &str) -> Vec<usize> {
    let mut offsets = vec![0; text.len() + 1];
    let mut units = 0;
    for (byte, ch) in text.char_indices() {
        for offset in &mut offsets[byte..byte + ch.len_utf8()] {
            *offset = units;
        }
        units += ch.len_utf16();
    }
    offsets[text.len()] = units;
    offsets
}
fn tree(node: SyntaxNode, offsets: &[usize]) -> Value {
    let range = node.text_range();
    let children: Vec<Value> = node
        .children_with_tokens()
        .map(|child| match child {
            forgegraph_syntax::syntax_kind::SyntaxElement::Node(n) => tree(n, offsets),
            forgegraph_syntax::syntax_kind::SyntaxElement::Token(t) => json!({
                "kind": format!("{:?}", t.kind()), "token": true,
                "start": offsets[u32::from(t.text_range().start()) as usize],
                "end": offsets[u32::from(t.text_range().end()) as usize], "children": []
            }),
        })
        .collect();
    json!({"kind":format!("{:?}",node.kind()),"start":offsets[u32::from(range.start()) as usize],"end":offsets[u32::from(range.end()) as usize],"children":children})
}
pub fn inspect(input: &str) -> Value {
    let Ok(input) = serde_json::from_str::<Input>(input) else {
        return json!({"error":"Invalid editor request"});
    };
    if input.files.len() > 50 || input.files.iter().map(|f| f.text.len()).sum::<usize>() > 500_000 {
        return json!({"error":"Editor limit: 50 files and 500 KB of source"});
    }
    let source = input
        .files
        .iter()
        .find(|f| f.path == input.current_file)
        .map(|f| f.text.as_str())
        .unwrap_or("");
    let parsed = forgegraph_syntax::parse(source);
    let syntax = tree(parsed.syntax(), &utf16_offsets(source));
    let mut package = Package::inline(
        &input.name,
        input
            .files
            .iter()
            .map(|f| (f.path.clone(), f.text.clone()))
            .collect(),
    );
    package.edition = "2027".into();
    let module_of = |parsed: &forgegraph_syntax::Parse| {
        parsed
            .root()
            .declarations()
            .find_map(|d| {
                if let forgegraph_syntax::ast::Declaration::Module(m) = d {
                    m.path().map(|p| p.text())
                } else {
                    None
                }
            })
            .unwrap_or_else(|| "_".into())
    };
    let current_module = module_of(&parsed);
    let mut symbols = Vec::new();
    for file in &input.files {
        let parsed = forgegraph_syntax::parse(&file.text);
        if module_of(&parsed) != current_module {
            continue;
        }
        for node in parsed.syntax().children() {
            let identifiers: Vec<String> = node
                .children_with_tokens()
                .filter_map(|e| e.into_token())
                .filter(|t| t.kind() == forgegraph_syntax::SyntaxKind::IDENT)
                .map(|t| t.text().to_owned())
                .collect();
            let index = if identifiers.first().is_some_and(|s| s == "export") {
                2
            } else {
                1
            };
            if let Some(name) = identifiers.get(index) {
                symbols
                    .push(json!({"name":name,"kind":format!("{:?}",node.kind()),"file":file.path}));
            }
        }
    }
    let compilation = compile(&package, &[]);
    let diagnostics: Vec<Value> = compilation
        .diagnostics
        .iter()
        .map(|d| {
            let text = input
                .files
                .iter()
                .find(|f| f.path == d.file)
                .map(|f| f.text.as_str())
                .unwrap_or("");
            let offsets = utf16_offsets(text);
            let mut diagnostic = serde_json::to_value(d).expect("diagnostic serializes");
            diagnostic["start"] = json!(offsets[d.start.min(text.len())]);
            diagnostic["end"] = json!(offsets[d.end.min(text.len())]);
            diagnostic
        })
        .collect();
    json!({"tree":syntax,"symbols":symbols,"diagnostics":diagnostics,
        "taxonomy":serde_json::from_str::<Value>(forgegraph_semantic::taxonomy::TAXONOMY_JSON).expect("built-in taxonomy"),
        "scalars":forgegraph_semantic::compiler::SCALARS})
}

// A small owned-buffer ABI avoids a generated JS dependency. Only the browser worker calls it.
#[cfg(target_arch = "wasm32")]
mod wasm {
    #[unsafe(no_mangle)]
    pub extern "C" fn editor_alloc(len: usize) -> *mut u8 {
        Box::into_raw(vec![0u8; len].into_boxed_slice()).cast::<u8>()
    }
    /// # Safety
    /// `ptr` and `len` must be a live allocation returned by this module, freed exactly once.
    #[unsafe(no_mangle)]
    pub unsafe extern "C" fn editor_free(ptr: *mut u8, len: usize) {
        unsafe {
            drop(Box::from_raw(std::ptr::slice_from_raw_parts_mut(ptr, len)));
        }
    }
    /// # Safety
    /// `ptr` must reference `len` initialized bytes in this module's memory for this call.
    #[unsafe(no_mangle)]
    pub unsafe extern "C" fn editor_inspect(ptr: *const u8, len: usize) -> u64 {
        let bytes = unsafe { std::slice::from_raw_parts(ptr, len) };
        let source = std::str::from_utf8(bytes).unwrap_or("");
        let output = super::inspect(source)
            .to_string()
            .into_bytes()
            .into_boxed_slice();
        let len = output.len();
        let ptr = Box::into_raw(output).cast::<u8>();
        ((ptr as u64) << 32) | len as u64
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn preserves_source_and_reports_utf16_ranges() {
        let source = "// 😀 café\nexport resource Person {\n  id : id\n  email : email\n}\n";
        let result = inspect(&json!({"name":"@local/test", "currentFile":"main.forge", "files":[{"path":"main.forge","text":source}]}).to_string());
        let tree = &result["tree"];
        assert_eq!(tree["end"], source.encode_utf16().count());
        let resource = tree["children"]
            .as_array()
            .unwrap()
            .iter()
            .find(|n| n["kind"] == "RESOURCE_DECL")
            .unwrap();
        assert_eq!(resource["start"], "// 😀 café\n".encode_utf16().count());
        assert!(
            resource["children"]
                .as_array()
                .unwrap()
                .iter()
                .any(|n| n["kind"] == "FIELD_DECL")
        );
        assert_eq!(result["taxonomy"]["version"], "data-taxonomy/1");
    }

    #[test]
    fn diagnoses_using_the_actual_forge_compiler() {
        let result = inspect(&json!({"name":"@local/test", "currentFile":"main.forge", "files":[{"path":"main.forge","text":"resource Person {\n id : id\n email : MissingType\n}\n"}]}).to_string());
        assert!(!result["diagnostics"].as_array().unwrap().is_empty());
        assert!(result["diagnostics"].to_string().contains("MissingType"));
    }
}
