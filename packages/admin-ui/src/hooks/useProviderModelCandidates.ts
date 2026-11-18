import { useEffect, useState } from "react";
import type { AdminApi } from "../lib/api";

/** 上游模型候选（model-discovery 01）：实时 models 列表优先，失败回落预设静态清单。 */
export interface ModelCandidates {
  /** null = 仍在拉取；空数组 = 已回落且预设也无候选（此时 source 为 none）。 */
  models: readonly string[] | null;
  source: "upstream" | "preset" | "none";
}

const EMPTY: readonly string[] = [];

/**
 * 拉取某供应商的上游模型候选（映射表单 / 连通性测试 / 批量导入共用，
 * 三处同一回落语义）。fallback 应传预设的 suggested_models（引用稳定，
 * 勿传每次渲染新建的数组，否则会循环重拉）。
 */
export function useProviderModelCandidates(
  api: AdminApi,
  providerId: string,
  fallback: readonly string[] | undefined,
): ModelCandidates {
  const [models, setModels] = useState<readonly string[] | null>(null);
  const [source, setSource] = useState<ModelCandidates["source"]>("none");

  useEffect(() => {
    if (providerId === "") return;
    let cancelled = false;
    setModels(null);
    setSource("none");
    api.listProviderModels(providerId).then(
      (result) => {
        if (!cancelled) {
          setModels(result.models);
          setSource("upstream");
        }
      },
      () => {
        if (cancelled) return;
        const resolved = fallback ?? EMPTY;
        setModels(resolved);
        setSource(resolved.length > 0 ? "preset" : "none");
      },
    );
    return () => {
      cancelled = true;
    };
  }, [api, providerId, fallback]);

  return { models, source };
}
