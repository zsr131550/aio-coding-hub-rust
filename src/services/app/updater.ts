import {
  desktopUpdaterCheck,
  desktopUpdaterDownloadAndInstall,
  parseDesktopUpdaterCheck,
  type DesktopUpdaterDownloadEvent,
} from "../desktop/updater";
import { AIO_UPDATE_CHANNEL_ENABLED } from "../../constants/urls";

export type UpdaterCheckUpdate = {
  rid: number;
  version?: string;
  currentVersion?: string;
  date?: string;
  body?: string;
};

export type UpdaterCheckResult = UpdaterCheckUpdate | null;

export const UPDATE_CHANNEL_DISABLED_CODE = "UPDATE_CHANNEL_DISABLED";

export function parseUpdaterCheckResult(value: unknown): UpdaterCheckResult {
  return parseDesktopUpdaterCheck(value);
}

function updateChannelDisabledError() {
  return new Error(`${UPDATE_CHANNEL_DISABLED_CODE}: update channel is disabled`);
}

export async function updaterCheck(): Promise<UpdaterCheckResult> {
  if (!AIO_UPDATE_CHANNEL_ENABLED) return null;
  return desktopUpdaterCheck();
}

export async function updaterDownloadAndInstall(options: {
  rid: number;
  onEvent?: (event: DesktopUpdaterDownloadEvent) => void;
  timeoutMs?: number;
}): Promise<boolean | null> {
  if (!AIO_UPDATE_CHANNEL_ENABLED) throw updateChannelDisabledError();
  return desktopUpdaterDownloadAndInstall(options);
}

export type UpdaterDownloadEvent = DesktopUpdaterDownloadEvent;
