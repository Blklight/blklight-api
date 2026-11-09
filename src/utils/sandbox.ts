import { Worker } from 'node:worker_threads';
import { transformSync } from 'esbuild';
import { ValidationError } from './errors';

const LOG_SEPARATOR = '\x00';

/** Extra time the host waits past the guest timeout (worker start + WASM load). */
const WORKER_GRACE_MS = 2000;
const GUEST_MEMORY_BYTES = 32 * 1024 * 1024;
const GUEST_STACK_BYTES = 512 * 1024;
const MAX_LOG_CHARS = 64 * 1024;
const MAX_CONCURRENT_RUNS = 4;

export type SupportedLanguage = 'javascript' | 'typescript';

/**
 * Runs inside a worker_thread. The submitted code executes in QuickJS (WASM):
 * a separate engine with its own heap and no Node objects, so there is no host
 * Function, process or require to reach. The only bridge is console.log, which
 * receives copies of guest values. The interrupt handler enforces the timeout
 * (including pending promise jobs) and the runtime caps memory and stack.
 */
const WORKER_SOURCE = `
const { parentPort, workerData } = require('node:worker_threads');
const { getQuickJS } = require(workerData.quickjsPath);

function format(value) {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (typeof value === 'object') {
    try { return JSON.stringify(value); } catch { return String(value); }
  }
  return String(value);
}

(async () => {
  const { code, timeout, memoryBytes, stackBytes, maxLogChars, separator } = workerData;
  const QuickJS = await getQuickJS();
  const runtime = QuickJS.newRuntime();
  runtime.setMemoryLimit(memoryBytes);
  runtime.setMaxStackSize(stackBytes);
  // Monotonic clock: wall-clock jumps (NTP, VM resume) must not end or extend a run.
  const deadline = performance.now() + timeout;
  runtime.setInterruptHandler(() => performance.now() > deadline);

  const vm = runtime.newContext();
  const logs = [];
  let logChars = 0;
  const log = vm.newFunction('log', (...args) => {
    const line = args.map((handle) => format(vm.dump(handle))).join(' ');
    logChars += line.length;
    if (logChars <= maxLogChars) logs.push(line);
  });
  const consoleHandle = vm.newObject();
  vm.setProp(consoleHandle, 'log', log);
  vm.setProp(vm.global, 'console', consoleHandle);
  log.dispose();
  consoleHandle.dispose();

  let failure = null;
  const result = vm.evalCode(code, 'exercise.js');
  if (result.error) {
    failure = vm.dump(result.error);
    result.error.dispose();
  } else {
    result.value.dispose();
    const jobs = runtime.executePendingJobs();
    if (jobs.error) {
      failure = vm.dump(jobs.error);
      jobs.error.dispose();
    }
  }

  // An interrupt inside an async function rejects its promise instead of
  // surfacing as an error, so the deadline is checked on its own.
  const timedOut = performance.now() > deadline;
  vm.dispose();
  runtime.dispose();

  if (timedOut) {
    parentPort.postMessage({ error: 'TIMEOUT' });
  } else if (failure === null) {
    parentPort.postMessage({ output: logs.join(separator) });
  } else {
    const message = failure && typeof failure === 'object' && failure.message ? failure.message : String(failure);
    parentPort.postMessage({ error: message });
  }
})().catch((error) => {
  parentPort.postMessage({ error: String((error && error.message) || error) });
});
`;

// Eval workers resolve require() from process.cwd(); resolve here instead.
const QUICKJS_PATH = require.resolve('quickjs-emscripten');

let activeRuns = 0;

function sanitizeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return 'An unexpected error occurred';
}

/**
 * Transpile TypeScript code to JavaScript using esbuild.
 * @param code - The TypeScript code to transpile
 * @returns Transpiled JavaScript string
 * @throws ValidationError if TypeScript syntax error
 */
export function transpileTS(code: string): string {
  try {
    const result = transformSync(code, { loader: 'ts', target: 'es2020' });
    return result.code;
  } catch (error) {
    throw new ValidationError(sanitizeError(error));
  }
}

/**
 * Execute JavaScript or TypeScript code in an isolated QuickJS engine running
 * in a worker thread, so a hostile or runaway submission can neither reach the
 * host process nor block the API's event loop.
 * @param code - The code to execute
 * @param language - The language of the code ('javascript' or 'typescript')
 * @param timeout - Execution timeout in milliseconds (default: 3000)
 * @returns The captured console.log output as a string
 * @throws ValidationError if language is unsupported, execution times out, the
 *   runner is saturated, or the code throws
 */
export async function executeCode(
  code: string,
  language: SupportedLanguage,
  timeout: number = 3000
): Promise<string> {
  if (!['javascript', 'typescript'].includes(language)) {
    throw new ValidationError('Unsupported language. Supported: javascript, typescript');
  }

  const codeToExecute = language === 'typescript' ? transpileTS(code) : code;

  if (activeRuns >= MAX_CONCURRENT_RUNS) {
    throw new ValidationError('Code runner is busy, try again in a moment');
  }
  activeRuns += 1;

  try {
    return await new Promise<string>((resolve, reject) => {
      const worker = new Worker(WORKER_SOURCE, {
        eval: true,
        workerData: {
          code: codeToExecute,
          timeout,
          memoryBytes: GUEST_MEMORY_BYTES,
          stackBytes: GUEST_STACK_BYTES,
          maxLogChars: MAX_LOG_CHARS,
          separator: LOG_SEPARATOR,
          quickjsPath: QUICKJS_PATH,
        },
        resourceLimits: { maxOldGenerationSizeMb: 64, maxYoungGenerationSizeMb: 16 },
      });

      let settled = false;
      const settle = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(killTimer);
        void worker.terminate();
        fn();
      };

      const killTimer = setTimeout(() => {
        settle(() => reject(new ValidationError('Code execution timed out')));
      }, timeout + WORKER_GRACE_MS);

      worker.once('message', (message: { output?: string; error?: string }) => {
        if (typeof message.output === 'string') {
          const output = message.output;
          settle(() => resolve(output));
        } else if (message.error === 'TIMEOUT') {
          settle(() => reject(new ValidationError('Code execution timed out')));
        } else {
          settle(() => reject(new ValidationError(message.error ?? 'Code execution failed')));
        }
      });
      worker.once('error', (error) => {
        settle(() => reject(new ValidationError(sanitizeError(error))));
      });
      worker.once('exit', () => {
        settle(() => reject(new ValidationError('Code execution failed')));
      });
    });
  } finally {
    activeRuns -= 1;
  }
}
