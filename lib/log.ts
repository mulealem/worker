/**
 * Minimal structured logger. JSON when `LOG_JSON=1`, otherwise a
 * human-readable single-line format suitable for Coolify's log viewer.
 *
 * Usage:
 *   import { log } from "./log.js";
 *   const logv = log.child({ module: "verifier-queue" });
 *   logv.info("processing job", { paymentId });
 */
type Level = "debug" | "info" | "warn" | "error";

interface Fields {
  [key: string]: unknown;
}

const json = process.env.LOG_JSON === "1";

function emit(level: Level, msg: string, fields?: Fields): void {
  const rec = {
    ts: new Date().toISOString(),
    level,
    service: "pygate-worker",
    msg,
    ...fields,
  };
  if (json) {
    process.stdout.write(JSON.stringify(rec) + "\n");
    return;
  }
  const extras = fields ? " " + JSON.stringify(fields) : "";
  process.stdout.write(`${rec.ts} ${level.toUpperCase()} ${msg}${extras}\n`);
}

export interface Logger {
  debug: (msg: string, fields?: Fields) => void;
  info: (msg: string, fields?: Fields) => void;
  warn: (msg: string, fields?: Fields) => void;
  error: (msg: string, fields?: Fields) => void;
  child: (fields: Fields) => Logger;
}

function makeLogger(base: Fields): Logger {
  return {
    debug: (msg, fields) => emit("debug", msg, { ...base, ...fields }),
    info: (msg, fields) => emit("info", msg, { ...base, ...fields }),
    warn: (msg, fields) => emit("warn", msg, { ...base, ...fields }),
    error: (msg, fields) => emit("error", msg, { ...base, ...fields }),
    child: (fields) => makeLogger({ ...base, ...fields }),
  };
}

export const log: Logger = makeLogger({});