import type { BrowserManager } from "../browser-manager.js";
import { QuickJSSandbox } from "./quickjs-sandbox.js";

interface ScriptOutput {
  onStdout: (data: string) => void;
  onStderr: (data: string) => void;
}

export async function runScript(
  script: string,
  manager: BrowserManager,
  browserName: string,
  output: ScriptOutput,
  options: { timeout?: number; memoryLimitBytes?: number; humanize?: boolean } = {}
): Promise<void> {
  const sandbox = new QuickJSSandbox({
    manager,
    browserName,
    onStdout: output.onStdout,
    onStderr: output.onStderr,
    memoryLimitBytes: options.memoryLimitBytes,
    timeoutMs: options.timeout,
    humanize: options.humanize ?? false,
  });

  try {
    await sandbox.initialize();
    await sandbox.executeScript(`(async () => {\n${script}\n})()`);
  } finally {
    await sandbox.dispose();
  }
}
