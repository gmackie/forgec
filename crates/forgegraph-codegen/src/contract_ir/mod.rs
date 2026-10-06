//! ForgeGraph contract IR v1 (`@forgegraph/contract/ir`): the per-app API
//! registry format `fg contract publish` uploads. `forgec build` emits it
//! next to `openapi.json`.
//!
//! ForgeGraph's `validateContract` recomputes every fingerprint, so
//! [`canonical`] reproduces its `JSON.stringify` bytes exactly.

pub mod canonical;
pub mod emit;

pub use emit::{EmitOptions, emit, service_id_for, verify};
