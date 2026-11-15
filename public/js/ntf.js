// Decoder for NTF1 frames produced by nighttrace/field.py:encode.
// magic "NTF1", uint16 width, uint16 height, uint32 reserved, float16 pixels (MJy/sr), uint8 flag categories.

export const CAT = { BAD: 1, TRANSIENT: 2, ARTIFACT: 4, SOURCE: 8, NODATA: 16, CLIPPED: 32 };

const F16 = (() => {
  const table = new Float32Array(65536);
  for (let h = 0; h < 65536; h++) {
    const s = h & 0x8000 ? -1 : 1, e = (h >> 10) & 0x1f, f = h & 0x3ff;
    table[h] = e === 0 ? s * 2 ** -14 * (f / 1024) : e === 31 ? (f ? NaN : s * Infinity) : s * 2 ** (e - 15) * (1 + f / 1024);
  }
  return table;
})();

export async function gunzipIfNeeded(buffer) {
  const bytes = new Uint8Array(buffer);
  if (bytes[0] !== 0x1f || bytes[1] !== 0x8b) return buffer;
  if (typeof DecompressionStream === "undefined") throw new Error("gzip unsupported");
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
  return await new Response(stream).arrayBuffer();
}

export function decodeNTF(buffer) {
  const view = new DataView(buffer);
  if (buffer.byteLength < 12 || String.fromCharCode(...new Uint8Array(buffer, 0, 4)) !== "NTF1") throw new Error("not NTF1");
  const width = view.getUint16(4, true), height = view.getUint16(6, true), n = width * height;
  if (width < 16 || height < 16 || width > 2048 || height > 2048 || buffer.byteLength !== 12 + 3 * n) throw new Error("bad NTF1 size");
  const raw = new Uint16Array(buffer.slice(12, 12 + 2 * n));
  const data = new Float32Array(n);
  for (let i = 0; i < n; i++) data[i] = F16[raw[i]];
  const flags = new Uint8Array(buffer.slice(12 + 2 * n));
  return { width, height, data, flags };
}
