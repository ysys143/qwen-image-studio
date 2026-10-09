import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * 프롬프트를 저장 파일에 평문으로 남기지 않기 위한 대칭키 암호화.
 *
 * jobs.json 은 저장소 안에 있고 상태를 확인하려는 사람·에이전트가 자주 연다.
 * 프롬프트를 그대로 두면 파일을 읽는 것만으로 내용이 드러나므로,
 * 저장할 때 암호화하고 열쇠는 저장소 밖에 0600 으로 보관한다.
 * 메모리 안의 Job 객체는 평문을 유지하므로 앱 동작은 달라지지 않는다.
 */
const PREFIX = "enc:v1:";

const SERVICE_DIR =
  process.env.QWEN_SERVICE_DIR ?? path.join(os.homedir(), "Library", "Application Support", "Qwen Image Studio");
const KEY_FILE = process.env.QWEN_PROMPT_KEY_FILE ?? path.join(SERVICE_DIR, "prompt-key");

let cachedKey: Buffer | null = null;

function loadKey(): Buffer {
  const fromEnv = process.env.QWEN_PROMPT_KEY;
  if (fromEnv) {
    const buf = Buffer.from(fromEnv, "base64");
    if (buf.length !== 32) throw new Error("QWEN_PROMPT_KEY 는 base64 로 인코딩한 32바이트 키여야 합니다.");
    return buf;
  }
  try {
    // 키 파일 경로는 환경변수로 바뀔 수 있다. 빌드 시 프로젝트 전체를 추적하지 않게 표시한다.
    const buf = Buffer.from(fs.readFileSync(/*turbopackIgnore: true*/ KEY_FILE, "utf8").trim(), "base64");
    if (buf.length === 32) return buf;
  } catch {
    /* 아직 없으면 아래에서 새로 만든다 */
  }
  const created = crypto.randomBytes(32);
  fs.mkdirSync(path.dirname(KEY_FILE), { recursive: true, mode: 0o700 });
  fs.writeFileSync(KEY_FILE, created.toString("base64"), { mode: 0o600 });
  return created;
}

function key(): Buffer {
  return (cachedKey ??= loadKey());
}

/** 평문을 `enc:v1:<iv>:<tag>:<ciphertext>` 로 만든다. 빈 문자열은 그대로 둔다. */
export function encryptText(plain: string): string {
  if (!plain) return plain;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key(), iv);
  const body = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return PREFIX + [iv, cipher.getAuthTag(), body].map((b) => b.toString("base64")).join(":");
}

/** 암호문을 평문으로 되돌린다. 접두사가 없으면 기존 평문 데이터로 보고 그대로 돌려준다. */
export function decryptText(stored: string): string {
  if (!stored || !stored.startsWith(PREFIX)) return stored;
  const [ivPart, tagPart, bodyPart] = stored.slice(PREFIX.length).split(":");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key(), Buffer.from(ivPart, "base64"));
  decipher.setAuthTag(Buffer.from(tagPart, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(bodyPart, "base64")), decipher.final()]).toString("utf8");
}

export const PROMPT_KEY_FILE = KEY_FILE;
