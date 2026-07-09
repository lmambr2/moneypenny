/**
 * Whisper model ladder + quant selection (docs/voice.md, dual editions).
 *
 * Server can select large-v3 when VRAM allows; SBC RKNN uses INT8 (W8A8)
 * quant paths for encoder/decoder pairs. Pure config helpers — driven by
 * env in sidecars and optional bot voice overrides.
 */

/** Canonical faster-whisper / whisper.cpp model ids we support. */
export const WHISPER_MODEL_IDS = [
  "tiny",
  "base",
  "small",
  "medium",
  "large-v3",
  "large-v3-turbo",
  "distil-large-v3",
] as const;

export type WhisperModelId = (typeof WHISPER_MODEL_IDS)[number];

/** Quant / compute types for CPU / CUDA / RKNN paths. */
export const STT_QUANT_TYPES = ["int8", "int8_float16", "float16", "float32"] as const;
export type SttQuantType = (typeof STT_QUANT_TYPES)[number];

export type SttEdition = "sbc" | "server" | "dev";

export interface SttModelSelection {
  model: WhisperModelId;
  /** Backend hint: rknn | faster-whisper | whisper-cpp */
  backend: "rknn" | "faster-whisper" | "whisper-cpp";
  /** Compute / quant type applied to the load path. */
  quant: SttQuantType;
  /** Edition default this selection is for. */
  edition: SttEdition;
  /** Absolute or container paths for RKNN pair when backend=rknn. */
  rknnEncoder?: string;
  rknnDecoder?: string;
}

const DEFAULTS: Record<SttEdition, { model: WhisperModelId; backend: SttModelSelection["backend"]; quant: SttQuantType }> =
  {
    sbc: { model: "base", backend: "rknn", quant: "int8" },
    server: { model: "medium", backend: "whisper-cpp", quant: "float16" },
    dev: { model: "tiny", backend: "faster-whisper", quant: "int8" },
  };

export function isWhisperModelId(v: string): v is WhisperModelId {
  return (WHISPER_MODEL_IDS as readonly string[]).includes(v);
}

export function isSttQuantType(v: string): v is SttQuantType {
  return (STT_QUANT_TYPES as readonly string[]).includes(v);
}

/**
 * Resolve STT model + quant from env-like inputs.
 * `preferLargeV3` on server edition upgrades medium → large-v3 when VRAM free.
 * RKNN always defaults quant to int8 (INT8 path for exported .rknn pairs).
 */
export function resolveSttModelSelection(opts: {
  edition?: SttEdition;
  model?: string | null;
  backend?: string | null;
  quant?: string | null;
  preferLargeV3?: boolean;
  rknnModelsDir?: string | null;
  rknnEncoder?: string | null;
  rknnDecoder?: string | null;
}): SttModelSelection {
  const edition: SttEdition =
    opts.edition === "sbc" || opts.edition === "server" || opts.edition === "dev"
      ? opts.edition
      : "dev";
  const base = DEFAULTS[edition];

  let model: WhisperModelId = base.model;
  if (opts.model && isWhisperModelId(opts.model.trim())) {
    model = opts.model.trim() as WhisperModelId;
  } else if (opts.preferLargeV3 && edition === "server") {
    model = "large-v3";
  }

  let backend = base.backend;
  const b = (opts.backend || "").trim().toLowerCase();
  if (b === "rknn" || b === "rknpu" || b === "npu") backend = "rknn";
  else if (b === "whisper-cpp" || b === "whisper_cpp" || b === "cpp") backend = "whisper-cpp";
  else if (b === "faster-whisper" || b === "faster_whisper" || b === "cpu") backend = "faster-whisper";

  let quant: SttQuantType = base.quant;
  if (opts.quant && isSttQuantType(opts.quant.trim().toLowerCase())) {
    quant = opts.quant.trim().toLowerCase() as SttQuantType;
  } else if (backend === "rknn") {
    quant = "int8"; // INT8 quant path for RKNN Whisper
  }

  const dir = (opts.rknnModelsDir || "/models/rknn").replace(/\/$/, "");
  const enc =
    (opts.rknnEncoder || "").trim() ||
    (backend === "rknn" ? `${dir}/whisper-${model}-encoder.rknn` : undefined);
  const dec =
    (opts.rknnDecoder || "").trim() ||
    (backend === "rknn" ? `${dir}/whisper-${model}-decoder.rknn` : undefined);

  return {
    model,
    backend,
    quant,
    edition,
    rknnEncoder: enc,
    rknnDecoder: dec,
  };
}

/** Env map the STT sidecars consume (for docs + tests of the real path). */
export function sttSelectionToEnv(sel: SttModelSelection): Record<string, string> {
  const env: Record<string, string> = {
    STT_MODEL: sel.model,
    STT_BACKEND: sel.backend === "whisper-cpp" ? "whisper-cpp" : sel.backend,
    STT_COMPUTE_TYPE: sel.quant,
  };
  if (sel.backend === "rknn") {
    env.STT_BACKEND = "rknn";
    if (sel.rknnEncoder) env.RKNN_ENCODER = sel.rknnEncoder;
    if (sel.rknnDecoder) env.RKNN_DECODER = sel.rknnDecoder;
  }
  return env;
}
