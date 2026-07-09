/**
 * Radio / DJ "audio color" overlays — ffmpeg `-af` chains that tint music
 * like AM, FM, telephone, vinyl, or lofi. Applied on decode (AudioPlayer),
 * not on spoken bumpers (speech stays intelligible).
 */

export type AudioColorPreset = "off" | "am" | "fm" | "telephone" | "vinyl" | "lofi";

export const AUDIO_COLOR_PRESETS: readonly AudioColorPreset[] = [
  "off",
  "am",
  "fm",
  "telephone",
  "vinyl",
  "lofi",
] as const;

/** Human labels for Settings / API docs. */
export const AUDIO_COLOR_LABELS: Record<AudioColorPreset, string> = {
  off: "Clean (no overlay)",
  am: "AM radio — narrow band, mid-forward",
  fm: "FM radio — wide, light compression",
  telephone: "Telephone — band-limited voice band",
  vinyl: "Vinyl — rolled highs + light slap echo",
  lofi: "Lo-fi — soft bandlimit + light crush",
};

/**
 * Normalize user/config input to a known preset (default off).
 */
export function parseAudioColorPreset(raw: unknown): AudioColorPreset {
  if (typeof raw !== "string") return "off";
  const s = raw.trim().toLowerCase();
  if ((AUDIO_COLOR_PRESETS as readonly string[]).includes(s)) {
    return s as AudioColorPreset;
  }
  // aliases
  if (s === "none" || s === "clean" || s === "flat" || s === "") return "off";
  if (s === "am-radio" || s === "amradio") return "am";
  if (s === "phone" || s === "tel") return "telephone";
  if (s === "lo-fi" || s === "lo_fi") return "lofi";
  return "off";
}

/**
 * ffmpeg filter graph for a preset, or null when off / unknown.
 * Filters use only widely available lavfi filters (highpass/lowpass/eq/comp/acrusher).
 */
export function audioColorFilter(
  preset: AudioColorPreset | string | undefined | null,
): string | null {
  const p = parseAudioColorPreset(preset ?? "off");
  switch (p) {
    case "am":
      // Classic AM: cut deep bass + highs (~200–4.5 kHz), mid bump, squash dynamics.
      return [
        "highpass=f=200",
        "lowpass=f=4500",
        "equalizer=f=1200:width_type=h:width=900:g=5",
        "acompressor=threshold=-22dB:ratio=5:attack=15:release=180:makeup=4",
        "volume=1.05",
      ].join(",");
    case "fm":
      return [
        "highpass=f=40",
        "lowpass=f=15000",
        "acompressor=threshold=-18dB:ratio=2.5:attack=10:release=120:makeup=2",
        "volume=1.0",
      ].join(",");
    case "telephone":
      return [
        "highpass=f=300",
        "lowpass=f=3400",
        "equalizer=f=1800:width_type=h:width=600:g=3",
        "acompressor=threshold=-20dB:ratio=6:attack=5:release=80:makeup=5",
        "volume=1.1",
      ].join(",");
    case "vinyl":
      return [
        "highpass=f=50",
        "lowpass=f=11000",
        "equalizer=f=80:width_type=h:width=40:g=-2",
        "aecho=0.8:0.9:40:0.15",
        "volume=0.95",
      ].join(",");
    case "lofi":
      return [
        "highpass=f=90",
        "lowpass=f=6500",
        "acrusher=bits=12:mode=log:aa=1",
        "acompressor=threshold=-20dB:ratio=3:attack=20:release=200:makeup=3",
        "volume=1.0",
      ].join(",");
    default:
      return null;
  }
}
