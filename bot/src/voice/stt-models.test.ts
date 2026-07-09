import { describe, expect, it } from "vitest";
import {
  isWhisperModelId,
  resolveSttModelSelection,
  sttSelectionToEnv,
  WHISPER_MODEL_IDS,
} from "./stt-models.js";

describe("resolveSttModelSelection", () => {
  it("server defaults to medium whisper-cpp float16", () => {
    const s = resolveSttModelSelection({ edition: "server" });
    expect(s).toMatchObject({
      model: "medium",
      backend: "whisper-cpp",
      quant: "float16",
      edition: "server",
    });
  });

  it("preferLargeV3 upgrades server to large-v3", () => {
    const s = resolveSttModelSelection({ edition: "server", preferLargeV3: true });
    expect(s.model).toBe("large-v3");
    expect(isWhisperModelId("large-v3")).toBe(true);
    expect(WHISPER_MODEL_IDS).toContain("large-v3");
  });

  it("explicit large-v3 is applied", () => {
    const s = resolveSttModelSelection({
      edition: "server",
      model: "large-v3",
      backend: "faster-whisper",
      quant: "float16",
    });
    expect(s.model).toBe("large-v3");
    expect(sttSelectionToEnv(s).STT_MODEL).toBe("large-v3");
  });

  it("SBC RKNN defaults INT8 quant and rknn paths for base", () => {
    const s = resolveSttModelSelection({ edition: "sbc" });
    expect(s.model).toBe("base");
    expect(s.backend).toBe("rknn");
    expect(s.quant).toBe("int8");
    expect(s.rknnEncoder).toMatch(/whisper-base-encoder\.rknn$/);
    expect(s.rknnDecoder).toMatch(/whisper-base-decoder\.rknn$/);
    const env = sttSelectionToEnv(s);
    expect(env.STT_COMPUTE_TYPE).toBe("int8");
    expect(env.STT_BACKEND).toBe("rknn");
    expect(env.RKNN_ENCODER).toBe(s.rknnEncoder);
  });

  it("explicit int8 quant on rknn is preserved", () => {
    const s = resolveSttModelSelection({
      edition: "sbc",
      model: "tiny",
      backend: "rknn",
      quant: "int8",
      rknnModelsDir: "/models/rknn",
    });
    expect(s.quant).toBe("int8");
    expect(s.rknnEncoder).toBe("/models/rknn/whisper-tiny-encoder.rknn");
  });
});
