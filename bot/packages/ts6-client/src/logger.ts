/**
 * Minimal structured-logger surface used by the TS client.
 * Compatible with pino (and any duck-typed equivalent) without coupling
 * this package to the bot process logger module.
 */
export interface Ts6Logger {
  debug: {
    (msg: string): void;
    (obj: object, msg?: string): void;
  };
  info: {
    (msg: string): void;
    (obj: object, msg?: string): void;
  };
  warn: {
    (msg: string): void;
    (obj: object, msg?: string): void;
  };
  error: {
    (msg: string): void;
    (obj: object, msg?: string): void;
  };
}

/** @deprecated Prefer Ts6Logger — alias kept for call-site clarity. */
export type Logger = Ts6Logger;
