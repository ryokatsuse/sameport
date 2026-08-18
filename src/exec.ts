import { execFile } from "node:child_process";

export interface RunResult {
  stdout: string;
  stderr: string;
  code: number;
}

/** 外部コマンドを実行する。コマンド不在・非ゼロ終了でも reject しない。 */
export function run(cmd: string, args: string[]): Promise<RunResult> {
  return new Promise((resolve) => {
    execFile(
      cmd,
      args,
      { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
      (err, stdout, stderr) => {
        let code = 0;
        if (err) {
          const c = (err as NodeJS.ErrnoException & { code?: unknown }).code;
          code = typeof c === "number" ? c : 1;
        }
        resolve({ stdout: stdout ?? "", stderr: stderr ?? "", code });
      },
    );
  });
}
