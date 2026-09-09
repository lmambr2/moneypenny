//! Middleware chain building — mirrors `teamspeak-js/src/events.ts`

use crate::types::{CommandHandler, CommandMiddleware, EventHandler, EventMiddleware};

pub fn build_command_chain(
    middlewares: &[Box<dyn CommandMiddleware>],
    base: CommandHandler,
) -> CommandHandler {
    let mut chain = base;
    for mw in middlewares.iter().rev() {
        chain = mw.wrap(chain);
    }
    chain
}

pub fn build_event_chain(
    middlewares: &[Box<dyn EventMiddleware>],
    base: EventHandler,
) -> EventHandler {
    let mut chain = base;
    for mw in middlewares.iter().rev() {
        chain = mw.wrap(chain);
    }
    chain
}
