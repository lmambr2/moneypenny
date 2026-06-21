import type { Request, Response, NextFunction, RequestHandler } from "express";
import type multer from "multer";

/** Normalized multer file list from `upload.array()` middleware. */
export function uploadedFiles(req: Request): Express.Multer.File[] {
  const files = req.files;
  if (Array.isArray(files)) return files;
  return [];
}

export interface MulterArrayOptions {
  /** Shown when `LIMIT_FILE_SIZE` fires. */
  fileSizeMessage?: string;
  /** Shown when `LIMIT_UNEXPECTED_FILE` fires. */
  unexpectedFileMessage?: string;
}

/**
 * Express middleware wrapping `multer.array()` with JSON error responses
 * instead of opaque multer failures.
 */
export function multerArray(
  uploader: multer.Multer,
  field: string,
  maxCount: number,
  opts: MulterArrayOptions = {},
): RequestHandler {
  const fileSizeMessage = opts.fileSizeMessage ?? "File too large";
  const unexpectedFileMessage = opts.unexpectedFileMessage ?? `Too many files (max ${maxCount} per upload)`;

  return (req, res, next) => {
    uploader.array(field, maxCount)(req, res, (err: unknown) => {
      if (!err) {
        next();
        return;
      }
      const merr = err as { code?: string; message?: string };
      if (merr.code === "LIMIT_FILE_SIZE") {
        res.status(413).json({ error: fileSizeMessage, code: "FILE_TOO_LARGE" });
        return;
      }
      if (merr.code === "LIMIT_UNEXPECTED_FILE") {
        res.status(400).json({ error: unexpectedFileMessage, code: "VALIDATION_ERROR" });
        return;
      }
      res.status(400).json({ error: merr.message || "Upload error", code: "VALIDATION_ERROR" });
    });
  };
}