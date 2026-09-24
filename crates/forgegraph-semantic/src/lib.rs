//! Forge semantic layer: package loading, symbol resolution, checks, DomainIR.

pub mod analysis;
pub mod assembly;
pub mod capability;
pub mod compiler;
pub mod concept;
pub mod concept_governance;
mod concept_interactions;
pub mod concept_realization;
pub mod concept_registry;
pub mod concept_semantics;
mod concept_subjects;
pub mod concept_traceability;
mod concept_validation;
pub mod cron;
pub mod diagnostics;
pub mod diff;
pub mod ir;
pub mod package;
pub mod source_map;
pub mod taxonomy;

pub use compiler::{Compilation, compile};
pub use diagnostics::{Diagnostic, Severity};
pub use ir::DomainIR;
pub use package::{LoadError, Package, SourceFile, load_package};
