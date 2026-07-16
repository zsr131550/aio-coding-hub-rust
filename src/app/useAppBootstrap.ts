import { useAppBackgroundTasks } from "./useAppBackgroundTasks";
import { useAppEventListeners } from "./useAppEventListeners";
import { useAppRuntimeSync } from "./useAppRuntimeSync";
import { useAppStartupTasks } from "./useAppStartupTasks";

export function useAppBootstrap(
  options: {
    enableBackgroundTasks?: boolean;
    enableAmbientStartupTasks?: boolean;
  } = {}
) {
  const { enableBackgroundTasks = true } = options;
  const { enableAmbientStartupTasks = enableBackgroundTasks } = options;

  useAppRuntimeSync();
  useAppEventListeners();
  useAppStartupTasks({ enableAmbientTasks: enableAmbientStartupTasks });
  useAppBackgroundTasks(enableBackgroundTasks);
}
