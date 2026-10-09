import fs from "node:fs";
import path from "node:path";
import { DATA_DIR, UPLOADS_DIR } from "./paths";
import { listUploads, removeUpload } from "./uploads";
import { store } from "./store";
import { worker } from "./queue";

/**
 * 자동 정리 정책.
 *
 * 이 앱은 참조 이미지를 업로드 폴더에 계속 쌓고, 작업을 끝없이 대기열에 넣는다.
 * 그대로 두면 디스크가 차고 스왑이 자라 시스템 전체가 멈춘다(실제로 겪은 문제).
 * 그래서 세 가지를 상시 강제한다.
 *
 *   1. 대기열 상한   - 처리 속도보다 빨리 쌓이지 못하게 막는다
 *   2. 디스크 하한   - 남은 공간이 부족하면 새 작업을 받지 않는다
 *   3. 참조 이미지 정리 - 어느 작업도 쓰지 않는 업로드 파일을 주기적으로 지운다
 *
 * 값은 모두 환경변수로 조정한다.
 */

function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/** 대기열에 동시에 설 수 있는 최대 작업 수 (실행 중 포함). 0 이면 무제한. */
export const MAX_QUEUE = envNumber("QWEN_MAX_QUEUE", 300);
/** 새 작업을 거절하기 시작하는 최소 디스크 여유 (GB). */
export const MIN_FREE_GB = envNumber("QWEN_MIN_FREE_GB", 8);
/** 어느 작업도 참조하지 않는 참조 이미지를 지우는 주기 (분). 0 이면 끔. */
export const CLEANUP_INTERVAL_MIN = envNumber("QWEN_CLEANUP_INTERVAL_MIN", 30);
/** 참조 이미지로 인정하는 최소 보존 시간 (분). 방금 올린 이미지를 오해로 지우지 않는다. */
export const UPLOAD_GRACE_MIN = envNumber("QWEN_UPLOAD_GRACE_MIN", 30);

export interface QueueCapacity {
  ok: boolean;
  /** 거절 사유 (ok 이면 undefined) */
  reason?: string;
  /** 대기열이 꽉 찼는지 */
  queueFull: boolean;
  /** 디스크가 부족한지 */
  diskLow: boolean;
  queued: number;
  freeBytes?: number;
}

/** 파일이 있는 볼륨의 남은 공간 (바이트). statfs 를 못 쓰면 undefined. */
export function freeBytes(dir: string = DATA_DIR): number | undefined {
  try {
    const s = fs.statfsSync(dir);
    return Number(s.bavail) * Number(s.bsize);
  } catch {
    return undefined;
  }
}

/** 지금 새 작업을 받을 수 있는지. 대기열 길이와 디스크 여유를 함께 본다. */
export function checkCapacity(adding = 1): QueueCapacity {
  const queued = worker.queuedCount();
  const free = freeBytes();
  const queueFull = MAX_QUEUE > 0 && queued + adding > MAX_QUEUE;
  const floor = MIN_FREE_GB * 1024 ** 3;
  const diskLow = free !== undefined && free < floor;

  let reason: string | undefined;
  if (queueFull) {
    reason = `대기열이 가득 찼습니다 (${queued}/${MAX_QUEUE}). 생성이 끝난 뒤 다시 시도하세요.`;
  } else if (diskLow) {
    const gb = (n: number) => (n / 1024 ** 3).toFixed(1);
    reason = `디스크 여유가 부족합니다 (${gb(free!)}GB < ${MIN_FREE_GB}GB). 오래된 참조 이미지나 출력을 정리하세요.`;
  }
  return { ok: !queueFull && !diskLow, reason, queueFull, diskLow, queued, freeBytes: free };
}

/**
 * 어느 작업도 참조하지 않는 업로드 이미지를 지운다.
 * 보존 시간 안에 올린 이미지는 건드리지 않는다(작업을 만들기 직전에 올린 경우).
 * 지운 장수를 돌려준다.
 */
export function cleanupOrphanUploads(now = Date.now()): number {
  const jobs = store.list();
  const referenced = new Set<string>();
  for (const job of jobs) {
    for (const id of job.params.references ?? []) referenced.add(id);
  }
  const graceMs = UPLOAD_GRACE_MIN * 60_000;
  let removed = 0;
  for (const entry of listUploads()) {
    if (referenced.has(entry.id)) continue;
    if (now - entry.createdAt < graceMs) continue;
    try {
      if (removeUpload(entry.id)) removed++;
    } catch (err) {
      console.error(`[retention] 참조 이미지 삭제 실패 ${entry.id}:`, err);
    }
  }
  return removed;
}

/** 업로드 폴더와 출력 폴더의 용량 (바이트). */
export function dataUsage(): { uploads: number; images: number } {
  const sum = (dir: string) => {
    try {
      return fs
        .readdirSync(dir)
        .filter((n) => n.endsWith(".png"))
        .reduce((acc, n) => {
          try {
            return acc + fs.statSync(path.join(dir, n)).size;
          } catch {
            return acc;
          }
        }, 0);
    } catch {
      return 0;
    }
  };
  return { uploads: sum(UPLOADS_DIR), images: sum(path.join(DATA_DIR, "..", "..", "outputs", "web")) };
}

let timer: NodeJS.Timeout | undefined;

/**
 * 주기 정리 예약. 서버가 뜰 때 한 번 부르면 이후 알아서 돈다.
 * 첫 정리는 1분 뒤에 해서 방금 올린 이미지가 아니라 오래된 것만 지우게 한다.
 */
export function startRetentionScheduler(): void {
  const g = globalThis as unknown as { __qwenRetentionStarted?: boolean };
  if (g.__qwenRetentionStarted) return;
  g.__qwenRetentionStarted = true;

  const enabled = CLEANUP_INTERVAL_MIN > 0;
  const run = () => {
    try {
      const removed = cleanupOrphanUploads();
      const free = freeBytes();
      const gb = free === undefined ? "?" : (free / 1024 ** 3).toFixed(1);
      if (removed > 0) console.log(`[retention] 참조 이미지 ${removed}장 정리, 남은 공간 ${gb}GB`);
      else console.log(`[retention] 정리할 참조 이미지 없음, 남은 공간 ${gb}GB`);
    } catch (err) {
      console.error("[retention] 정리 중 오류:", err);
    }
  };

  const first = setTimeout(run, 60_000);
  first.unref();
  if (enabled) {
    timer = setInterval(run, CLEANUP_INTERVAL_MIN * 60_000);
    timer.unref();
  }
  console.log(
    `[retention] 대기열 상한 ${MAX_QUEUE || "무제한"}, 디스크 하한 ${MIN_FREE_GB}GB, ` +
      `참조 정리 ${enabled ? `${CLEANUP_INTERVAL_MIN}분마다` : "끔"}`,
  );
}

export function stopRetentionScheduler(): void {
  if (timer) clearInterval(timer);
  timer = undefined;
}
