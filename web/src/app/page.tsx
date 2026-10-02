"use client";

import { useCallback, useRef, useState } from "react";
import { toast } from "sonner";
import { ActiveJobs } from "@/components/active-jobs";
import { Gallery } from "@/components/gallery";
import {
  GeneratorForm,
  type LoadRequest,
  type PromptMatrixRequest,
  type ReferenceRequest,
} from "@/components/generator-form";
import { api } from "@/lib/client-api";
import { Header } from "@/components/header";
import { Tabs, TabsContent } from "@/components/ui/tabs";
import { useJobs } from "@/hooks/use-jobs";
import type { GenerationParams, Job } from "@/lib/types";
import { cn } from "@/lib/utils";

export default function Home() {
  const {
    active,
    retrying,
    finished,
    previews,
    engine,
    connected,
    loaded,
    createJobs,
    createPromptMatrix,
    cancelJob,
    deleteJobs,
    startComfy,
    refresh,
  } =
    useJobs();
  const [loadRequest, setLoadRequest] = useState<LoadRequest | null>(null);
  const [referenceRequest, setReferenceRequest] = useState<ReferenceRequest | null>(null);
  const [promptMatrixRequest, setPromptMatrixRequest] = useState<PromptMatrixRequest | null>(null);
  const [resultsTab, setResultsTab] = useState("progress");
  const formRef = useRef<HTMLDivElement>(null);

  const handleSubmit = useCallback(
    async (params: GenerationParams, count: number, perReference = false) => {
      try {
        setResultsTab("progress");
        await createJobs(params, count, perReference);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "작업을 추가하지 못했습니다");
      }
    },
    [createJobs],
  );

  /**
   * 갤러리에서 실패한 작업을 다시 시도한다. 대기열에 새 작업을 넣되 화면은 갤러리에 그대로 둔다.
   * 재시도가 진행 중임을 갤러리 카드에서 보여줄 수 있도록 새 작업 id 를 돌려준다.
   */
  const handleRetry = useCallback(
    async (params: GenerationParams, keepSeed: boolean): Promise<string | undefined> => {
      try {
        const jobs = await createJobs({ ...params, seed: keepSeed ? params.seed : null }, 1);
        toast.info("같은 설정으로 다시 시도합니다. 진행 상황은 진행 중 탭에서 볼 수 있습니다.");
        return jobs[0]?.id;
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "다시 시도하지 못했습니다");
        return undefined;
      }
    },
    [createJobs],
  );

  const handleLoadParams = useCallback((params: GenerationParams) => {
    setLoadRequest({ params, nonce: Date.now() });
    // 설정은 생성 패널에서 고치므로, 숨겨진 갤러리 탭에 있으면 진행 중 탭으로 옮겨 보여준다.
    setResultsTab("progress");
    formRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    toast("설정을 불러왔습니다. 필요한 값을 고친 뒤 생성을 시작하세요.");
  }, []);

  /** 갤러리 이미지를 참조 이미지로 넘긴다. add 는 현재 목록에 덧붙이고, replace 는 그 이미지로 바꾼다. */
  const handleReferences = useCallback(async (jobs: Job[], mode: "add" | "replace") => {
    if (jobs.length === 0) return;
    try {
      const ids: string[] = [];
      for (let i = 0; i < jobs.length; i += 8) {
        const copied = await Promise.all(jobs.slice(i, i + 8).map((job) => api.uploadFromJob(job.id)));
        ids.push(...copied.map((info) => info.id));
      }
      setReferenceRequest({ ids, mode, nonce: Date.now() });
      // 갤러리 탭에서는 생성 패널을 숨기므로, 결과를 확인할 수 있도록 진행 중 탭으로 전환한다.
      setResultsTab("progress");
      formRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "참조 이미지로 추가하지 못했습니다");
    }
  }, []);

  const handleQueuePromptMatrix = useCallback(async (jobs: Job[], prompts: string[]) => {
    const ids: string[] = [];
    for (let i = 0; i < jobs.length; i += 8) {
      const copied = await Promise.all(jobs.slice(i, i + 8).map((job) => api.uploadFromJob(job.id)));
      ids.push(...copied.map((info) => info.id));
    }
    setResultsTab("progress");
    setPromptMatrixRequest({ ids, prompts, nonce: Date.now() });
  }, []);

  const handleSubmitPromptMatrix = useCallback(
    async (params: GenerationParams, prompts: string[]) => {
      setResultsTab("progress");
      await createPromptMatrix(params, prompts);
    },
    [createPromptMatrix],
  );

  // 갤러리에서는 생성 패널을 감춘다. 마운트는 유지해 입력값과 참조 이미지를 보존한다.
  const showForm = resultsTab === "progress";

  return (
    <div className="flex min-h-screen flex-col">
      <Header
        engine={engine}
        connected={connected}
        onStartComfy={() => void startComfy()}
        resultsTab={resultsTab}
        onResultsTabChange={setResultsTab}
        activeCount={active.length}
        doneCount={finished.filter((job) => job.status === "done").length + retrying.length}
      />
      <main className="mx-auto w-full max-w-[1600px] flex-1 px-4 py-6 lg:px-8">
        <div className={cn("grid gap-6", showForm && "lg:grid-cols-[400px_minmax(0,1fr)] xl:grid-cols-[440px_minmax(0,1fr)]")}>
          <div
            ref={formRef}
            className={cn(
              "scroll-mt-20",
              showForm ? "lg:sticky lg:top-20 lg:max-h-[calc(100vh-6rem)] lg:self-start lg:overflow-y-auto lg:pr-1" : "hidden",
            )}
          >
            <GeneratorForm
              engine={engine}
              loadRequest={loadRequest}
              referenceRequest={referenceRequest}
              promptMatrixRequest={promptMatrixRequest}
              finishedJobs={finished}
              onSubmit={handleSubmit}
              onSubmitPromptMatrix={handleSubmitPromptMatrix}
            />
          </div>
          <div className="flex min-w-0 flex-col">
            <Tabs value={resultsTab} onValueChange={(value) => setResultsTab(value as string)}>
              <TabsContent value="progress" className="mt-4">
                <ActiveJobs jobs={active} previews={previews} onCancel={(id) => void cancelJob(id)} />
              </TabsContent>
              <TabsContent value="gallery" className="mt-4">
                <Gallery
                  jobs={[...finished, ...retrying]}
                  loaded={loaded}
                  onDelete={(ids) => void deleteJobs(ids)}
                  onLoadParams={handleLoadParams}
                  onRegenerate={handleRetry}
                  activeJobIds={active.map((job) => job.id)}
                  retryingJobIds={retrying.map((job) => job.id)}
                  onRefresh={() => void refresh()}
                  onAddReferences={(jobs) => void handleReferences(jobs, "add")}
                  onEditImage={(job) => void handleReferences([job], "replace")}
                  onQueuePromptMatrix={handleQueuePromptMatrix}
                />
              </TabsContent>
            </Tabs>
          </div>
        </div>
      </main>
    </div>
  );
}
