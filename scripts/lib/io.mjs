import { mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

export function parseArgs(argv, defaults = {}) {
  const result = { ...defaults };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) throw new Error(`Unexpected positional argument: ${token}`);
    const equals = token.indexOf('=');
    if (equals !== -1) {
      result[token.slice(2, equals)] = token.slice(equals + 1);
      continue;
    }
    const key = token.slice(2);
    const next = argv[index + 1];
    if (next === undefined || next.startsWith('--')) result[key] = true;
    else {
      result[key] = next;
      index += 1;
    }
  }
  return result;
}

export async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

export async function writeTextAtomic(path, content) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, content, 'utf8');
  await rename(temporary, path);
}

export async function writeJsonAtomic(path, value) {
  await writeTextAtomic(path, `${JSON.stringify(value, null, 2)}\n`);
}

export async function withFileLock(path, callback, options = {}) {
  const staleMs = Number(options.staleMs ?? 6 * 60 * 60 * 1000);
  let handle;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      handle = await open(path, 'wx');
      break;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      const info = await stat(path).catch(() => null);
      const stale = info && Date.now() - info.mtimeMs > staleMs;
      if (attempt === 0 && stale) {
        await rm(path, { force: true });
        continue;
      }
      throw new Error(`Another ingestion scan owns ${path}; wait for it to finish or remove a verified stale lock`);
    }
  }
  if (!handle) throw new Error(`Could not acquire ingestion lock ${path}`);
  try {
    await handle.writeFile(`${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`, 'utf8');
    return await callback();
  } finally {
    await handle.close().catch(() => {});
    await rm(path, { force: true }).catch(() => {});
  }
}

export async function fetchJson(url, options = {}) {
  const retries = Number(options.retries ?? 3);
  const timeoutMs = Number(options.timeoutMs ?? 30_000);
  let lastError;
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: {
          accept: 'application/json',
          'user-agent': options.userAgent ?? 'xiaosonglu-songlist-pipeline/1.0',
          ...(options.headers ?? {}),
        },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
      const text = await response.text();
      try {
        return JSON.parse(text);
      } catch (error) {
        throw new Error(`Invalid JSON from ${url}: ${error.message}`);
      }
    } catch (error) {
      lastError = error;
      if (attempt < retries) await new Promise(resolve => setTimeout(resolve, attempt * 750));
    }
  }
  throw new Error(`Failed to fetch ${url}: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

export function requireString(value, name) {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${name} is required`);
  return value.trim();
}

export function isoDateInZone(epochMs, timeZone = 'Asia/Hong_Kong') {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(epochMs));
  const get = type => parts.find(part => part.type === type)?.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

export function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '';
  const rounded = Math.floor(seconds);
  const hours = Math.floor(rounded / 3600);
  const minutes = Math.floor((rounded % 3600) / 60);
  const remainder = rounded % 60;
  return [hours, minutes, remainder].map(value => String(value).padStart(2, '0')).join(':');
}

export function normalizeText(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}
