fn main() {
    println!("cargo:rerun-if-changed=src/parser.c");
    cc::Build::new()
        .include("src")
        .file("src/parser.c")
        .warnings(false)
        .compile("tree-sitter-forge");
}
