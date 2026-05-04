export function parseEmbedding(
  blob: Uint8Array | null | undefined,
  text: string | null | undefined
): Float32Array | null {
  if (blob && blob.byteLength > 0) {
    if (blob.byteLength % 4 !== 0) return null;
    // Copy into fresh ArrayBuffer — SQLite drivers may return pooled Buffer
    // objects that get reused across queries, silently corrupting cached vectors.
    const copy = new ArrayBuffer(blob.byteLength);
    new Uint8Array(copy).set(blob);
    return new Float32Array(copy);
  }
  if (text) {
    try {
      const arr: unknown = JSON.parse(text);
      if (!Array.isArray(arr) || !arr.every((v: unknown) => typeof v === 'number' && isFinite(v))) return null;
      return new Float32Array(arr as number[]);
    } catch { return null; }
  }
  return null;
}
