import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { run } from '../src/cli.js';

const FIXTURE = new URL('./fixtures/workspace/', import.meta.url);

// A fresh copy of the fixture workspace per test, since most commands write the file they read.
export function workspace() {
  const dir = mkdtempSync(join(tmpdir(), 'yamlctl-'));
  cpSync(FIXTURE, dir, { recursive: true });
  return dir;
}

export function emptyDir() {
  return mkdtempSync(join(tmpdir(), 'yamlctl-empty-'));
}

// The command run in process, its output captured, so a test reads what a person would see and the exit status they would get.
export function cli(dir, args, { stdin = '' } = {}) {
  let out = '';
  let err = '';
  const code = run(args, { cwd: dir, out: (text) => (out += text), err: (text) => (err += text), stdin: () => stdin });
  return { code, out, err };
}

export const read = (dir, file) => readFileSync(join(dir, file), 'utf8');
export function write(dir, file, text) {
  mkdirSync(dirname(join(dir, file)), { recursive: true });
  writeFileSync(join(dir, file), text);
}
