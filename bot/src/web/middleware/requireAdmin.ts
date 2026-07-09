import type { NextFunction, Request, Response } from "express";

export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  if (!req.user) {
    res.status(401).json({ error: "unauthenticated" });
    return;
  }
  if (req.user.role !== "admin") {
    res.status(403).json({
      error: "forbidden",
      message: "Admin privileges are required for this action.",
      code: "PERMISSION_DENIED",
    });
    return;
  }
  next();
}
