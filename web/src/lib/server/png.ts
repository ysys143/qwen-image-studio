import fs from "node:fs";

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** PNG 를 바꾸지 않고 그대로 둘 텍스트 청크(메타데이터) 종류. */
const TEXT_CHUNKS = new Set(["tEXt", "iTXt", "zTXt"]);

/**
 * PNG 파일에서 텍스트 청크(tEXt/iTXt/zTXt)를 제거한다.
 *
 * ComfyUI 는 생성 이미지에 워크플로 전체를 `prompt` tEXt 청크로 박아 넣는다.
 * 그 안에 프롬프트 원문이 그대로 들어 있어, 이미지 파일만 열어도 내용이 드러난다.
 * 픽셀 데이터(IDAT)는 건드리지 않고 메타데이터만 걷어낸다.
 * 실제로 지운 청크 수를 돌려준다.
 */
export function stripPngTextChunks(file: string): number {
  const data = fs.readFileSync(file);
  if (data.length < 8 || !data.subarray(0, 8).equals(PNG_SIGNATURE)) return 0;
  const parts: Buffer[] = [data.subarray(0, 8)];
  let offset = 8;
  let removed = 0;
  while (offset + 8 <= data.length) {
    const length = data.readUInt32BE(offset);
    const type = data.subarray(offset + 4, offset + 8).toString("latin1");
    const end = offset + 12 + length;
    if (end > data.length) break;
    if (TEXT_CHUNKS.has(type)) removed++;
    else parts.push(data.subarray(offset, end));
    offset = end;
    if (type === "IEND") break;
  }
  if (removed > 0) fs.writeFileSync(file, Buffer.concat(parts));
  return removed;
}

/** PNG 헤더(IHDR)에서 가로·세로를 읽는다. PNG 가 아니면 0 을 돌려준다. */
export function readPngSize(file: string): { width: number; height: number } {
  const fd = fs.openSync(file, "r");
  try {
    const buf = Buffer.alloc(24);
    fs.readSync(fd, buf, 0, 24, 0);
    const isPng = buf.readUInt32BE(0) === 0x89504e47;
    if (!isPng) return { width: 0, height: 0 };
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  } finally {
    fs.closeSync(fd);
  }
}
