//! Wasm-compatible bounded fail-open cache for Soroban RPC state reads.

mod cache;

pub use cache::{
    CacheConfig, CacheError, CacheStats, StateCache, DEFAULT_MAX_BYTES, DEFAULT_MAX_ENTRIES,
    DEFAULT_TTL_SECS, MAX_CACHE_BYTES, MAX_CACHE_ENTRIES,
};

#[cfg(target_arch = "wasm32")]
#[path = "wasm.rs"]
mod wasm;

#[cfg(target_arch = "wasm32")]
pub use wasm::*;
