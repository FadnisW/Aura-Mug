import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import crypto from 'node:crypto';
import readline from 'node:readline';
import { spawn, spawnSync } from 'node:child_process';
import { parseEnv } from 'node:util';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const projectRoot = path.resolve(__dirname, '../..');
export const gatewayRoot = path.join(projectRoot, 'gateway');

export function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function randomSecret(bytes = 32) {
  return crypto.randomBytes(bytes).toString('hex');
}

export function readEnvFile(file) {
  if (!fs.existsSync(file)) return {};
  try {
    return parseEnv(fs.readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

/**
 * Updates keys in an env file while preserving unrelated lines and comments.
 * @param {string} file
 * @param {Record<string, string|number|boolean>} updates
 */
export function upsertEnvFile(file, updates) {
  const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const wanted = new Map(
    Object.entries(updates).map(([key, value]) => [key, String(value)]),
  );
  const seen = new Set();
  const lines = existing.split(/\r?\n/).map((line) => {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
    if (!match) return line;
    const key = match[1];
    if (!wanted.has(key)) return line;
    seen.add(key);
    return `${key}=${wanted.get(key)}`;
  });

  for (const [key, value] of wanted) {
    if (!seen.has(key)) lines.push(`${key}=${value}`);
  }

  fs.mkdirSync(path.dirname(file), { recursive: true });
  const output = `${lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`;
  fs.writeFileSync(file, output, 'utf8');
}

export function writeFileIfMissing(file, content) {
  if (fs.existsSync(file)) return false;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, 'utf8');
  return true;
}

export async function isPortFree(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const socket = net.createConnection({ port: Number(port), host });
    let settled = false;
    const finish = (free) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(free);
    };
    socket.setTimeout(700);
    socket.once('connect', () => finish(false));
    socket.once('timeout', () => finish(true));
    socket.once('error', () => finish(true));
  });
}

export async function waitForHttp(url, { timeoutMs = 30_000, intervalMs = 400, label = url } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, {
        redirect: 'manual',
        signal: AbortSignal.timeout(2500),
      });
      if (response.ok) return response;
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await delay(intervalMs);
  }
  throw new Error(`Timed out waiting for ${label}: ${lastError?.message || 'no response'}`);
}

/**
 * @param {{name: string, command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, onExit?: (name: string, code: number|null, signal: string|null) => void}} options
 */
export function startService({ name, command, args, cwd, env, onExit }) {
  const child = spawn(command, args, {
    cwd,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  const prefix = `[${name}]`;
  const pipe = (stream, target) => {
    if (!stream) return;
    const reader = readline.createInterface({ input: stream, crlfDelay: Infinity });
    reader.on('line', (line) => target.write(`${prefix} ${line}\n`));
  };
  pipe(child.stdout, process.stdout);
  pipe(child.stderr, process.stderr);

  let reported = false;
  child.on('error', (error) => {
    if (reported) return;
    reported = true;
    process.stderr.write(`${prefix} failed to start: ${error.message}\n`);
    onExit?.(name, null, null);
  });
  child.on('exit', (code, signal) => {
    if (reported) return;
    reported = true;
    onExit?.(name, code, signal);
  });

  return { name, child };
}

export async function stopService(service, { timeoutMs = 4000 } = {}) {
  const child = service?.child;
  if (!child || child.exitCode !== null) return;

  const exited = new Promise((resolve) => child.once('exit', resolve));
  try {
    child.kill();
  } catch {
    // The process may already be gone.
  }

  const timedOut = await Promise.race([
    exited.then(() => false),
    delay(timeoutMs).then(() => true),
  ]);

  if (!timedOut) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  } else {
    try {
      child.kill('SIGKILL');
    } catch {
      // Ignore.
    }
  }
}

export function runNpm(cwd, args, { env = process.env } = {}) {
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const result = spawnSync(npm, args, {
    cwd,
    env,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  return result.status ?? 1;
}

export function runNode(script, args = [], { cwd = projectRoot, env = process.env } = {}) {
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd,
    env,
    stdio: 'inherit',
  });
  return result.status ?? 1;
}
