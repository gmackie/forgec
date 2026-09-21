//! Emitters. Generated artifacts are disposable and never hand-edited.

pub mod client;
pub mod openapi;

pub use client::client_ts;
pub use openapi::{openapi, smithy};
