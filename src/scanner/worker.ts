import { parentPort, workerData } from "node:worker_threads";
import {
  runScannerTickInProcess,
  type ScannerLoopState,
  type ScannerTickResult,
} from "./loop.js";

interface ScannerWorkerData {
  state?: ScannerLoopState;
}

interface ScannerWorkerMessage {
  ok: boolean;
  result?: ScannerTickResult;
  error?: string;
}

async function main(): Promise<ScannerWorkerMessage> {
  const state = (workerData as ScannerWorkerData | undefined)?.state;
  if (!state) {
    return { ok: false, error: "Scanner worker missing state" };
  }
  try {
    const result = await runScannerTickInProcess(state);
    return { ok: true, result };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

main()
  .then((message) => {
    parentPort?.postMessage(message);
  })
  .catch((err: unknown) => {
    parentPort?.postMessage({
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    } satisfies ScannerWorkerMessage);
  });
