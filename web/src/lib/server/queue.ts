import type { EngineStatus, Job, JobProgress } from "@/lib/types";
import { CancelledError, comfy } from "./comfy";
import { publish } from "./events";
import { mfluxAvailable, runMflux } from "./mflux";
import { MAX_ATTEMPTS, retryDelayMs } from "./retry";
import { store } from "./store";

type ProgressUpdate = Partial<JobProgress> & { promptId?: string };

/** 대기열이 빈 뒤 모델 메모리를 내리기까지 기다리는 시간 (ms). 0 이면 끔. */
const IDLE_RECLAIM_MS = Math.max(0, Number(process.env.QWEN_IDLE_RECLAIM_MS ?? 60_000) || 0);

class Worker {
  runningId: string | undefined;
  private cancelFns = new Map<string, () => Promise<void>>();
  private timing = new Map<string, { samplingStartedAt: number; firstStep: number }>();
  private kicking = false;
  private retryTimers = new Map<string, NodeJS.Timeout>();
  /** 마지막으로 모델 메모리를 내린 시각. 대기열이 빈 상태가 이어질 때 한 번만 내린다. */
  private lastReclaimAt = 0;
  private reclaimTimer: NodeJS.Timeout | undefined;

  kick(): void {
    if (this.runningId || this.kicking) return;
    const next = store
      .list()
      .filter((j) => j.status === "queued" && !(j.retryAt && j.retryAt > Date.now()))
      .sort((a, b) => a.createdAt - b.createdAt)[0];
    if (!next) {
      this.scheduleReclaim();
      return;
    }
    this.kicking = true;
    void this.run(next).finally(() => {
      this.kicking = false;
      setTimeout(() => this.kick(), 50);
    });
  }

  /**
   * 대기열이 빈 상태가 잠깐 이어지면 ComfyUI 가 붙들고 있는 모델을 내린다.
   * 곧 다음 작업이 들어올 수도 있으므로 유예 시간을 두고, 이미 내렸으면 다시 하지 않는다.
   */
  private scheduleReclaim(): void {
    if (this.reclaimTimer || !IDLE_RECLAIM_MS) return;
    if (Date.now() - this.lastReclaimAt < IDLE_RECLAIM_MS) return;
    this.reclaimTimer = setTimeout(() => {
      this.reclaimTimer = undefined;
      // 기다리는 동안 새 작업이 들어왔으면 내리지 않는다.
      if (this.runningId || this.kicking) return;
      const queued = this.queuedCount();
      if (queued > 0) return;
      this.lastReclaimAt = Date.now();
      void comfy.freeMemory(true).then((ok) => {
        if (ok) console.log("[worker] 대기열이 비어 모델 메모리를 반환했습니다.");
      });
    }, IDLE_RECLAIM_MS);
    this.reclaimTimer.unref();
  }

  private async run(job: Job): Promise<void> {
    // 작업이 들어오면 예약된 수거를 취소한다.
    if (this.reclaimTimer) {
      clearTimeout(this.reclaimTimer);
      this.reclaimTimer = undefined;
    }
    this.runningId = job.id;
    job.status = "running";
    job.startedAt = Date.now();
    job.retryAt = undefined;
    job.progress = { step: 0, total: job.params.steps, phase: "starting" };
    store.upsert(job);
    void publishEngineStatus();

    const update = (u: ProgressUpdate) => this.applyUpdate(job.id, u);
    const onCancelReady = (fn: () => Promise<void>) => this.cancelFns.set(job.id, fn);

    try {
      const image =
        job.params.engine === "mflux"
          ? await runMflux(job, update, onCancelReady)
          : await comfy.run(job, update, onCancelReady);
      store.patch(job.id, (j) => {
        j.status = "done";
        j.image = image;
        j.finishedAt = Date.now();
        j.progress = { step: j.params.steps, total: j.params.steps, phase: "finished" };
      });
    } catch (err) {
      const cancelled = err instanceof CancelledError;
      if (cancelled) {
        store.patch(job.id, (j) => {
          j.status = "cancelled";
          j.error = undefined;
          j.finishedAt = Date.now();
        });
      } else {
        const message = err instanceof Error ? err.message : String(err);
        // attempts 는 실제로 실패한 횟수다. 서버 재시작으로 끊긴 실행은 세지 않는다.
        const failedAttempts = (job.attempts ?? 0) + 1;
        store.patch(job.id, (j) => {
          j.attempts = failedAttempts;
        });
        if (failedAttempts < MAX_ATTEMPTS) {
          console.warn(`[worker] 작업 ${job.id} 실패 (${failedAttempts}/${MAX_ATTEMPTS}회), 자동 재시도: ${message}`);
          this.scheduleRetry(job.id, failedAttempts, message);
        } else {
          store.patch(job.id, (j) => {
            j.status = "failed";
            j.error = message;
            j.finishedAt = Date.now();
          });
          console.error(`[worker] 작업 ${job.id} 실패 (${MAX_ATTEMPTS}/${MAX_ATTEMPTS}회, 재시도 소진):`, err);
        }
      }
    } finally {
      this.cancelFns.delete(job.id);
      this.timing.delete(job.id);
      this.runningId = undefined;
      comfy.invalidateStatus();
      void publishEngineStatus();
    }
  }

  /** 실패한 작업을 대기열로 되돌리고 백오프 뒤에 다시 실행한다. */
  private scheduleRetry(jobId: string, attempt: number, message: string): void {
    const delay = retryDelayMs(attempt);
    store.patch(jobId, (j) => {
      j.status = "queued";
      j.error = message;
      j.retryAt = Date.now() + delay;
      j.progress = { step: 0, total: j.params.steps, phase: "queued" };
    });
    const prev = this.retryTimers.get(jobId);
    if (prev) clearTimeout(prev);
    const timer = setTimeout(() => {
      this.retryTimers.delete(jobId);
      this.kick();
    }, delay);
    this.retryTimers.set(jobId, timer);
  }

  private applyUpdate(jobId: string, u: ProgressUpdate): void {
    store.patch(jobId, (j) => {
      if (j.status !== "running") return;
      if (u.promptId) j.promptId = u.promptId;
      const prev = j.progress;
      const next: JobProgress = {
        step: u.step ?? prev.step,
        total: u.total ?? prev.total,
        phase: u.phase ?? prev.phase,
      };
      if (next.phase === "sampling" && next.step > 0) {
        const t = this.timing.get(jobId);
        if (!t) {
          this.timing.set(jobId, { samplingStartedAt: Date.now(), firstStep: next.step });
        } else if (next.step > t.firstStep) {
          const perStep = (Date.now() - t.samplingStartedAt) / (next.step - t.firstStep);
          next.etaMs = Math.max(0, perStep * (next.total - next.step));
        }
      }
      j.progress = next;
    });
  }

  async cancel(id: string): Promise<Job | undefined> {
    const job = store.get(id);
    if (!job) return undefined;
    const pending = this.retryTimers.get(id);
    if (pending) {
      clearTimeout(pending);
      this.retryTimers.delete(id);
    }
    if (job.status === "queued") {
      return store.patch(id, (j) => {
        j.status = "cancelled";
        j.error = undefined;
        j.finishedAt = Date.now();
      });
    }
    if (job.status === "running") {
      const fn = this.cancelFns.get(id);
      if (fn) await fn();
      else {
        // 아직 엔진이 취소 함수를 등록하기 전이면 실패로 표시만 한다.
        return store.patch(id, (j) => {
          j.status = "cancelled";
          j.finishedAt = Date.now();
        });
      }
    }
    return store.get(id);
  }

  queuedCount(): number {
    return store.list().filter((j) => j.status === "queued").length;
  }
}

const g = globalThis as unknown as { __qwenWorker?: Worker };
export const worker: Worker = (g.__qwenWorker ??= new Worker());

export async function engineStatus(): Promise<EngineStatus> {
  const [comfyStatus, mflux] = await Promise.all([comfy.getStatus(), mfluxAvailable()]);
  return {
    comfy: { ...comfyStatus, starting: comfy.starting },
    mflux,
    worker: { runningJobId: worker.runningId, queued: worker.queuedCount() },
  };
}

export async function publishEngineStatus(): Promise<void> {
  try {
    publish({ type: "engine", status: await engineStatus() });
  } catch (err) {
    console.error("[worker] 엔진 상태 전송 실패:", err);
  }
}

// 서버가 시작될 때 대기 중이던 작업을 이어서 처리한다.
setTimeout(() => worker.kick(), 500);
