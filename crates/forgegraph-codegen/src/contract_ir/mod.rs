//! ForgeGraph contract IR v1 (`@forgegraph/contract/ir`): the per-app API
//! registry format `fg contract publish` uploads. `forgec build` emits it
//! next to `openapi.json`; `forgec import-contract` turns one back into a
//! Forge package; `forgec contract-diff` compares two.
//!
//! ForgeGraph's `validateContract` recomputes every fingerprint, so
//! [`canonical`] reproduces its `JSON.stringify` bytes exactly.

pub mod canonical;
pub mod diff;
pub mod emit;
pub mod import;

pub use diff::{DiffReport, Difference, diff};
pub use emit::{EmitOptions, emit, service_id_for, verify};
pub use import::{contract_to_openapi, import_contract};
