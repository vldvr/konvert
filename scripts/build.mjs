// Релизная сборка без локальных путей в бинарнике.
// Rust зашивает пути к исходникам в сообщения о панике; заменяем домашнюю
// папку и папку проекта на нейтральные имена. Аргументы передаются в `tauri build`.
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// При нескольких совпадениях rustc берёт последнее, поэтому проект идёт после домашней папки.
const flags = [
  `--remap-path-prefix=${homedir()}=~`,
  `--remap-path-prefix=${root}=konvert`,
];
// Через CARGO_ENCODED_RUSTFLAGS (разделитель \x1f) пути с пробелами не ломаются.
const existing = process.env.CARGO_ENCODED_RUSTFLAGS || (process.env.RUSTFLAGS || '').split(' ').filter(Boolean).join('\x1f');
const env = {
  ...process.env,
  CARGO_ENCODED_RUSTFLAGS: [existing, ...flags].filter(Boolean).join('\x1f'),
};
delete env.RUSTFLAGS;

const r = spawnSync('tauri', ['build', ...process.argv.slice(2)], { stdio: 'inherit', env, cwd: root, shell: process.platform === 'win32' });
process.exit(r.status ?? 1);
