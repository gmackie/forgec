//! Forge semantic layer: package loading, symbol resolution, checks, DomainIR.

pub mod compiler;
pub mod cron;
pub mod taxonomy;
pub mod diagnostics;
pub mod ir;
pub mod package;

pub use compiler::{compile, Compilation};
pub use diagnostics::{Diagnostic, Severity};
pub use ir::DomainIR;
pub use package::{load_package, LoadError, Package, SourceFile};
