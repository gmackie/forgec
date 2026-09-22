//! Forge semantic layer: package loading, symbol resolution, checks, DomainIR.

pub mod assembly;
pub mod capability;
pub mod compiler;
pub mod cron;
pub mod diagnostics;
pub mod diff;
pub mod ir;
pub mod package;
pub mod taxonomy;

pub use compiler::{Compilation, compile};
pub use diagnostics::{Diagnostic, Severity};
pub use ir::DomainIR;
pub use package::{LoadError, Package, SourceFile, load_package};
