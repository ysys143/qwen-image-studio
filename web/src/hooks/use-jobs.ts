"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { api } from "@/lib/client-api";
import { truncate } from "@/lib/format";
import type { EngineStatus, GenerationParams, Job, ServerEvent } from "@/lib/types";

interface State {
  jobs: Record<string, Job>;
  previews: Record<string, string>;
  engine: EngineStatus | null;
  connected: boolean;
  loaded: boolean;
}

export function useJobs() {
  const [state, setState] = useState<State>({
    jobs: {},
    previews: {},
    engine: null,
    connected: false,
    loaded: false,
  });
  const prevStatus = useRef<Record<string, Job["status"]>>({});

  useEffect(() => {
    let source: EventSource | null = null;
    let retry: number | undefined;
    let stopped = false;
    let hasSnapshot = false;

    const handle = (event: ServerEvent) => {
      switch (event.type) {
        case "snapshot": {
          hasSnapshot = true;
          for (const j of event.jobs) prevStatus.current[j.id] = j.status;
          setState((s) => ({
            ...s,
            jobs: Object.fromEntries(event.jobs.map((j) => [j.id, j])),
            loaded: true,
          }));
          break;
        }
        case "job": {
          const job = event.job;
          const prev = prevStatus.current[job.id];
          prevStatus.current[job.id] = job.status;
          if (prev && prev !== job.status) {
            if (job.status === "done") {
              toast.success("이미지 생성 완료", { description: truncate(job.params.prompt, 70) });
            } else if (job.status === "failed") {
              toast.error("이미지 생성 실패", { description: job.error ? truncate(job.error, 140) : undefined });
            }
          }
          setState((s) => {
            const previews = { ...s.previews };
            if (job.status !== "running") delete previews[job.id];
            return { ...s, jobs: { ...s.jobs, [job.id]: job }, previews };
          });
          break;
        }
        case "job-removed": {
          delete prevStatus.current[event.id];
          setState((s) => {
            const jobs = { ...s.jobs };
            const previews = { ...s.previews };
            delete jobs[event.id];
            delete previews[event.id];
            return { ...s, jobs, previews };
          });
          break;
        }
        case "preview":
          setState((s) => ({ ...s, previews: { ...s.previews, [event.id]: event.dataUrl } }));
          break;
        case "engine":
          setState((s) => ({ ...s, engine: event.status }));
          break;
        default:
          break;
      }
    };

    // Load the persisted job list over HTTP as well as SSE. On a cold Next.js
    // start this lets the gallery populate without waiting for the event route
    // to finish compiling and opening its long-lived stream.
    void api.listJobs().then(({ jobs }) => {
      if (stopped || hasSnapshot) return;
      for (const job of jobs) prevStatus.current[job.id] = job.status;
      setState((s) => (s.loaded ? s : { ...s, jobs: Object.fromEntries(jobs.map((job) => [job.id, job])), loaded: true }));
    }).catch((err) => {
      console.error("작업 목록을 불러오지 못했습니다", err);
    });

    const connect = () => {
      if (stopped) return;
      source = new EventSource("/api/events");
      source.onopen = () => setState((s) => ({ ...s, connected: true }));
      source.onmessage = (ev) => {
        try {
          handle(JSON.parse(ev.data) as ServerEvent);
        } catch (err) {
          console.error("이벤트 해석 실패", err);
        }
      };
      source.onerror = () => {
        setState((s) => ({ ...s, connected: false }));
        source?.close();
        source = null;
        retry = window.setTimeout(connect, 2000);
      };
    };
    connect();
    return () => {
      stopped = true;
      source?.close();
      if (retry) window.clearTimeout(retry);
    };
  }, []);

  const jobs = useMemo(() => Object.values(state.jobs).sort((a, b) => b.createdAt - a.createdAt), [state.jobs]);
  // 서버가 자동 재시도로 다시 돌린 작업(실패 이력이 있는 대기·실행 작업). 갤러리에서 "재시도 중"으로 보여준다.
  const retrying = useMemo(
    () => jobs.filter((j) => (j.attempts ?? 0) >= 1 && (j.status === "queued" || j.status === "running")),
    [jobs],
  );
  const active = useMemo(
    () =>
      jobs
        .filter((j) => j.status === "running" || (j.status === "queued" && (j.attempts ?? 0) === 0))
        .sort((a, b) => {
          if (a.status !== b.status) return a.status === "running" ? -1 : 1;
          return a.createdAt - b.createdAt;
        }),
    [jobs],
  );
  const finished = useMemo(() => jobs.filter((j) => j.status !== "running" && j.status !== "queued"), [jobs]);

  const createJobs = useCallback(async (params: GenerationParams, count = 1, perReference = false) => {
    const res = await api.createJobs({ params, count, perReference });
    const n = res.jobs.length;
    toast.info(
      perReference
        ? `참조 이미지 ${params.references.length}장에 프롬프트를 각각 적용하는 ${n}개 작업을 대기열에 추가했습니다`
        : n > 1
          ? `${n}개 작업을 대기열에 추가했습니다`
          : "작업을 대기열에 추가했습니다",
    );
    return res.jobs;
  }, []);

  const createPromptMatrix = useCallback(async (params: GenerationParams, prompts: string[]) => {
    const res = await api.createJobs({ params, prompts });
    toast.info(`${params.references.length}장 × ${prompts.length}개 프롬프트 = ${res.jobs.length}개 작업을 대기열에 추가했습니다`);
    return res.jobs;
  }, []);

  const cancelJob = useCallback(async (id: string) => {
    try {
      await api.cancelJob(id);
      toast("작업을 취소했습니다");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "취소하지 못했습니다");
    }
  }, []);

  const deleteJobs = useCallback(async (ids: string[]) => {
    if (ids.length === 0) return;
    try {
      if (ids.length === 1) await api.deleteJob(ids[0]);
      else await api.deleteJobs(ids);
      toast(ids.length > 1 ? `${ids.length}개 항목을 삭제했습니다` : "삭제했습니다");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "삭제하지 못했습니다");
    }
  }, []);

  const startComfy = useCallback(async () => {
    try {
      const res = await api.startComfy();
      if (res.starting) toast.info("ComfyUI 서버를 시작합니다. 준비까지 1~2분 걸립니다.");
      else toast("ComfyUI 서버가 이미 실행 중입니다");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "서버를 시작하지 못했습니다");
    }
  }, []);

  const refreshStatus = useCallback(async () => {
    try {
      const status = await api.status();
      setState((s) => ({ ...s, engine: status }));
    } catch {
      /* SSE 로 다시 받는다 */
    }
  }, []);

  /** 작업 목록과 엔진 상태를 서버에서 다시 불러온다. 갤러리 새로고침 버튼에서 쓴다. */
  const refresh = useCallback(async () => {
    const [jobsResult, statusResult] = await Promise.allSettled([api.listJobs(), api.status()]);
    if (jobsResult.status === "rejected") {
      toast.error(jobsResult.reason instanceof Error ? jobsResult.reason.message : "작업 목록을 불러오지 못했습니다");
      return;
    }
    const jobs = jobsResult.value.jobs;
    for (const job of jobs) prevStatus.current[job.id] = job.status;
    setState((s) => ({
      ...s,
      jobs: Object.fromEntries(jobs.map((job) => [job.id, job])),
      loaded: true,
      engine: statusResult.status === "fulfilled" ? statusResult.value : s.engine,
    }));
  }, []);

  return {
    jobs,
    active,
    retrying,
    finished,
    previews: state.previews,
    engine: state.engine,
    connected: state.connected,
    loaded: state.loaded,
    createJobs,
    createPromptMatrix,
    cancelJob,
    deleteJobs,
    startComfy,
    refreshStatus,
    refresh,
  };
}
