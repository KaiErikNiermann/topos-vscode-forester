/**
 * Run `forester query all` against a project root and parse the JSON output.
 *
 * No VS Code dependency. The CLI form invokes this; the extension's
 * `src/get-forest.ts` keeps its own VS-Code-aware getForest with caching.
 */
import { spawn } from "node:child_process";
import type { Forest, ForesterTree } from "./types";

export interface QueryOptions {
  readonly cwd: string;
  readonly foresterPath?: string; // defaults to "forester"
  readonly configFile?: string; // optional path to forest.toml
  readonly timeoutMs?: number; // defaults to 30_000
}

export const queryForest = async (opts: QueryOptions): Promise<Forest> => {
  const bin = opts.foresterPath ?? "forester";
  const args = ["query", "all", ...(opts.configFile ? [opts.configFile] : [])];
  const timeoutMs = opts.timeoutMs ?? 30_000;

  return new Promise<Forest>((resolve, reject) => {
    const child = spawn(bin, args, { cwd: opts.cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`forester query timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout.on("data", (c: Buffer) => {
      stdout += c.toString();
    });
    child.stderr.on("data", (c: Buffer) => {
      stderr += c.toString();
    });

    child.once("error", (err) => {
      clearTimeout(timer);
      reject(new Error(`failed to spawn ${bin}: ${err.message}`));
    });

    child.once("close", (code) => {
      clearTimeout(timer);
      // Forester sometimes emits Asai TTY-formatted warnings to stdout BEFORE
      // the JSON, and exit 0 even with warnings present. We locate the JSON
      // payload by scanning for the first line that starts with `[` or `{`.
      const jsonStart = (() => {
        const idxArr = stdout.search(/^\[/m);
        const idxObj = stdout.search(/^\{/m);
        if (idxArr === -1 && idxObj === -1) return -1;
        if (idxArr === -1) return idxObj;
        if (idxObj === -1) return idxArr;
        return Math.min(idxArr, idxObj);
      })();

      if (code !== 0 && jsonStart === -1) {
        reject(new Error(`forester query exited with code ${code}\n${stderr || stdout}`));
        return;
      }
      if (jsonStart === -1) {
        reject(new Error(`forester returned no JSON payload\n${stdout}`));
        return;
      }
      const payload = stdout.slice(jsonStart);
      try {
        const parsed: unknown = JSON.parse(payload);
        if (Array.isArray(parsed)) {
          resolve(parsed as Forest);
        } else if (parsed && typeof parsed === "object") {
          // Legacy format: { [uri: string]: Omit<ForesterTree, "uri"> }
          const obj = parsed as Record<string, Omit<ForesterTree, "uri">>;
          resolve(Object.entries(obj).map(([uri, entry]) => ({ uri, ...entry })));
        } else {
          reject(new Error(`forester returned unexpected JSON shape`));
        }
      } catch (err) {
        reject(new Error(`forester returned invalid JSON: ${err instanceof Error ? err.message : String(err)}\n${payload.slice(0, 400)}`));
      }
    });
  });
};
