/**
 * L2-normalize a vector for cosine similarity (TurboVec / cosine collections).
 * Empty or zero vectors are returned unchanged.
 */
export function l2Normalize(vec: number[]): number[] {
  if (!vec.length) return vec;
  let sum = 0;
  for (const x of vec) sum += x * x;
  const n = Math.sqrt(sum);
  if (!(n > 1e-12)) return vec.slice();
  const out = new Array<number>(vec.length);
  for (let i = 0; i < vec.length; i++) out[i] = vec[i] / n;
  return out;
}

export function l2NormalizeBatch(vectors: number[][]): number[][] {
  return vectors.map(l2Normalize);
}
