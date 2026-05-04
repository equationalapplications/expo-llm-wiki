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
      const arr: number[] = JSON.parse(text);
      return new Float32Array(arr);
    } catch { return null; }
  }
  return null;
}
