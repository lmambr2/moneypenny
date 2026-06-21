import { describe, it, expect } from "vitest";
import express from "express";
import multer from "multer";
import request from "supertest";
import { multerArray, uploadedFiles } from "./upload.js";

describe("uploadedFiles", () => {
  it("returns an array when req.files is an array", () => {
    const file = { originalname: "a.md" } as Express.Multer.File;
    expect(uploadedFiles({ files: [file] } as express.Request)).toEqual([file]);
  });

  it("returns empty when req.files is missing or not an array", () => {
    expect(uploadedFiles({} as express.Request)).toEqual([]);
    expect(uploadedFiles({ files: {} } as express.Request)).toEqual([]);
  });
});

describe("multerArray", () => {
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 8 },
  });

  function appWithUpload() {
    const app = express();
    app.post("/up", multerArray(upload, "files", 2, { fileSizeMessage: "too big" }), (req, res) => {
      res.json({ count: uploadedFiles(req).length });
    });
    return app;
  }

  it("passes valid uploads through", async () => {
    const res = await request(appWithUpload())
      .post("/up")
      .attach("files", Buffer.from("ok"), "ok.txt");
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(1);
  });

  it("returns 413 for LIMIT_FILE_SIZE", async () => {
    const res = await request(appWithUpload())
      .post("/up")
      .attach("files", Buffer.alloc(32), "big.txt");
    expect(res.status).toBe(413);
    expect(res.body).toEqual({ error: "too big", code: "FILE_TOO_LARGE" });
  });

  it("returns 400 for LIMIT_UNEXPECTED_FILE", async () => {
    const res = await request(appWithUpload())
      .post("/up")
      .attach("wrong", Buffer.from("x"), "x.txt");
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("VALIDATION_ERROR");
  });
});