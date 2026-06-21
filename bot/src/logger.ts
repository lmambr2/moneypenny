import pino from "pino";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

export type Logger = pino.Logger;

export function createLogger(logDir?: string): Logger {
  if (!logDir) {
    return pino({ level: "info" });
  }

  mkdirSync(logDir, { recursive: true });

  const transport = pino.transport({
    targets: [
      {
        target: "pino/file",
        options: { destination: 1 }, // stdout
        level: "info",
      },
      {
        target: "pino/file",
        options: { destination: join(logDir, "bot.log"), mkdir: true },
        level: "debug",
      },
    ],
  });

  // Prevent EINTR errors from crashing the process (known pino/thread-stream issue on Linux)
  transport.on("error", (err: Error) => {
    if ((err as NodeJS.ErrnoException).code === "EINTR") return;
    console.error("Logger transport error:", err);
  });

  return pino({ level: "debug" }, transport);
}
