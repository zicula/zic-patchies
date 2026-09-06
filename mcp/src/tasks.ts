/** Dev-server control, whitelisted repo tasks, and upstream sync. */

import { spawn, type ChildProcess } from 'node:child_process';

import { DEV_PORT, REPO_ROOT, UI_DIR } from './paths.js';

export type TaskName =
  | 'check'
  | 'lint'
  | 'format'
  | 'test'
  | 'build'
  | 'generate-schemas'
  | 'server-test'
  | 'docker-build';

const TASKS: Record<TaskName, { cwd: string; command: string[] }> = {
  check: { cwd: UI_DIR, command: ['bun', 'run', 'check'] },
  lint: { cwd: UI_DIR, command: ['bun', 'run', 'lint'] },
  format: { cwd: UI_DIR, command: ['bun', 'run', 'format'] },
  test: { cwd: UI_DIR, command: ['bun', 'run', 'test:unit'] },
  build: { cwd: UI_DIR, command: ['bun', 'run', 'build'] },
  'generate-schemas': {
    cwd: UI_DIR,
    command: ['bun', 'run', 'generate:schemas']
  },
  'server-test': {
    cwd: `${REPO_ROOT}/server`,
    command: ['go', 'test', './...']
  },
  'docker-build': {
    cwd: REPO_ROOT,
    command: ['docker', 'build', '-t', 'patchies', '.']
  }
};

export const TASK_NAMES = Object.keys(TASKS) as TaskName[];

export type CommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

export function runCommand(
  command: string[],
  options: { cwd: string; timeoutMs?: number; env?: Record<string, string> }
): Promise<CommandResult> {
  return new Promise((resolve) => {
    const [bin, ...args] = command;

    const child = spawn(bin, args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env }
    });

    let stdout = '';
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;

      child.kill('SIGKILL');
      settled = true;
      resolve({ exitCode: 124, stdout, stderr: `${stderr}\n[timed out]` });
    }, options.timeoutMs ?? 300_000);

    child.stdout.on('data', (chunk) => (stdout += chunk.toString()));
    child.stderr.on('data', (chunk) => (stderr += chunk.toString()));

    child.on('close', (code) => {
      if (settled) return;

      clearTimeout(timer);
      settled = true;
      resolve({ exitCode: code ?? -1, stdout, stderr });
    });

    child.on('error', (error) => {
      if (settled) return;

      clearTimeout(timer);
      settled = true;
      resolve({ exitCode: -1, stdout, stderr: `${stderr}${error.message}` });
    });
  });
}

export async function runTask(task: TaskName, timeoutMs?: number): Promise<CommandResult> {
  const spec = TASKS[task];

  if (!spec) throw new Error(`Unknown task "${task}". Known tasks: ${TASK_NAMES.join(', ')}`);

  return runCommand(spec.command, { cwd: spec.cwd, timeoutMs });
}

// ── Dev server ─────────────────────────────────────────────────────────────

let devServer: ChildProcess | null = null;
let devLog = '';

async function isDevPortOpen(): Promise<boolean> {
  try {
    const response = await fetch(`http://localhost:${DEV_PORT}/`, {
      signal: AbortSignal.timeout(1500)
    });

    return response.ok || response.status < 500;
  } catch {
    return false;
  }
}

export async function devServerStatus(): Promise<{
  managed: boolean;
  running: boolean;
  port: number;
  url: string;
  recentLog: string;
}> {
  return {
    managed: devServer !== null && devServer.exitCode === null,
    running: await isDevPortOpen(),
    port: DEV_PORT,
    url: `http://localhost:${DEV_PORT}/`,
    recentLog: devLog.slice(-2000)
  };
}

export async function startDevServer(): Promise<{
  started: boolean;
  message: string;
  url: string;
}> {
  const url = `http://localhost:${DEV_PORT}/`;

  if (await isDevPortOpen()) {
    return { started: false, message: `Something already serves ${url}`, url };
  }

  devLog = '';

  devServer = spawn('bun', ['run', 'dev', '--port', String(DEV_PORT)], {
    cwd: UI_DIR,
    env: { ...process.env }
  });

  devServer.stdout?.on('data', (chunk) => (devLog += chunk.toString()));
  devServer.stderr?.on('data', (chunk) => (devLog += chunk.toString()));

  const deadline = Date.now() + 90_000;

  while (Date.now() < deadline) {
    if (await isDevPortOpen()) return { started: true, message: `Dev server ready at ${url}`, url };
    if (devServer.exitCode !== null) {
      return {
        started: false,
        message: `Dev server exited: ${devLog.slice(-1000)}`,
        url
      };
    }

    await new Promise((r) => setTimeout(r, 1000));
  }

  return {
    started: false,
    message: `Dev server did not answer in 90s: ${devLog.slice(-1000)}`,
    url
  };
}

export function stopDevServer(): { stopped: boolean } {
  if (!devServer || devServer.exitCode !== null) return { stopped: false };

  devServer.kill('SIGTERM');
  devServer = null;

  return { stopped: true };
}

// ── Upstream sync ──────────────────────────────────────────────────────────

export async function upstreamStatus(): Promise<CommandResult> {
  await runCommand(['git', 'fetch', 'upstream'], {
    cwd: REPO_ROOT,
    timeoutMs: 120_000
  });

  return runCommand(['git', 'log', '--oneline', '--no-decorate', 'HEAD..upstream/main'], {
    cwd: REPO_ROOT
  });
}

export async function syncUpstream(
  mode: 'merge' | 'rebase'
): Promise<{ steps: { step: string; result: CommandResult }[]; ok: boolean }> {
  const steps: { step: string; result: CommandResult }[] = [];

  const run = async (step: string, command: string[], timeoutMs?: number) => {
    const result = await runCommand(command, { cwd: REPO_ROOT, timeoutMs });
    steps.push({ step, result });

    return result;
  };

  const dirty = await run('status', ['git', 'status', '--porcelain']);

  if (dirty.stdout.trim()) {
    return { steps, ok: false };
  }

  await run('fetch', ['git', 'fetch', 'upstream'], 120_000);

  const sync = await run(
    mode,
    mode === 'merge'
      ? ['git', 'merge', '--no-edit', 'upstream/main']
      : ['git', 'rebase', 'upstream/main'],
    120_000
  );

  return { steps, ok: sync.exitCode === 0 };
}
