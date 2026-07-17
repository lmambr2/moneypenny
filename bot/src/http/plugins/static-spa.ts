import path from "node:path";
import express from "express";
import type { HttpAppContext, HttpPlugin } from "../types.js";

/** Serve Vue SPA (public). SPA fallback excludes /api and /ws. */
export const registerStaticSpa: HttpPlugin = (ctx: HttpAppContext) => {
  const { app, options } = ctx;
  if (!options.staticDir) return;

  app.use(express.static(options.staticDir));
  app.get(/^(?!\/api|\/ws)/, (_req, res) => {
    res.sendFile(path.join(options.staticDir!, "index.html"));
  });
};
