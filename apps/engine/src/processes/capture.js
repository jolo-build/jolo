import { execFile } from 'node:child_process';

/**
 * Bounded asynchronous capture for fixed-argv utility commands.
 * @param {string[]} argv
 * @param {{ cwd?: string, env?: Record<string, string | undefined>, timeout?: number, maxBuffer?: number, signal?: AbortSignal }} [options]
 */
export function capture(argv, { cwd, env, timeout = 5000, maxBuffer = 4 * 1024 * 1024, signal } = {}) {
  return new Promise((resolve, reject) => {
    execFile(argv[0], argv.slice(1), { cwd, env, timeout, maxBuffer, signal, encoding: 'buffer', killSignal: 'SIGKILL' }, (error, stdout, stderr) => {
      if (error && typeof error.code !== 'number') return reject(error);
      resolve({ exitCode: error?.code ?? 0, stdout, stderr });
    });
  });
}
