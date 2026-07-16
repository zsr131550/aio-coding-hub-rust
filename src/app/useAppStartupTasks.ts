import { useStartupTask } from "../hooks/useStartupTask";
import { syncAppStartupStatusSnapshot } from "./startupStatusStore";
import {
  startupSyncDefaultPromptsFromFilesOncePerSession,
  startupSyncModelPricesOnce,
} from "../services/app/startup";

export function useAppStartupTasks({
  enableAmbientTasks = true,
}: { enableAmbientTasks?: boolean } = {}) {
  useStartupTask(syncAppStartupStatusSnapshot, "syncAppStartupStatusSnapshot", "启动状态同步失败");
  useStartupTask(
    startupSyncModelPricesOnce,
    "startupSyncModelPricesOnce",
    "启动模型定价同步失败",
    enableAmbientTasks
  );
  useStartupTask(
    startupSyncDefaultPromptsFromFilesOncePerSession,
    "startupSyncDefaultPromptsFromFilesOncePerSession",
    "启动默认提示词同步失败",
    enableAmbientTasks
  );
}
