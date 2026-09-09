// Copyright (c) 2026 Lane Ambrose
// SPDX-License-Identifier: MIT

//! Seed catalog + work-order helpers (rewrite Phase 8).
//! HTTP clients only — no HTML scrapers. Live UEX/sc-craft/sc-trade stay optional.

pub mod boxes;
pub mod catalog;
pub mod clients;
pub mod live;
pub mod orders;

pub use boxes::{calculate_boxes, largest_crate_that_fits, BoxBreakdown, STANDARD_CRATE_SCU};
pub use catalog::{
    find_method, find_ore, OreSpec, RefineMethod, Stability, CATALOG_AS_OF, CATALOG_DISCLAIMER,
    CATALOG_SOURCES, ORES, REFINE_METHODS,
};
pub use clients::{clients, score_blueprint_match, EconomyClients};
pub use live::{craft_bom_lines, handle_craft, handle_econ_live, handle_trade};
pub use orders::{
    format_mine, format_refine, handle_econ, handle_mine, handle_refine, parse_economy_args,
    parse_workorder_args, WorkOrderArgs, WorkOrderSub,
};

pub const MAX_OPEN_WORK_ORDERS: u32 = 100;

#[cfg(test)]
mod tests {
    #[test]
    fn crate_compiles() {
        assert_eq!(env!("CARGO_PKG_NAME"), "mp-economy");
    }
}
