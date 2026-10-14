import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JsonStore } from '../lib/store.mjs';
import { scanCodexHome } from '../lib/codex.mjs';
import { mergeCodexRecords } from '../lib/merge.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const store = new JsonStore(path.join(root, 'data', 'app.json'));
const state = await store.read();
if (state.users.length !== 1) throw new Error('本地账号不是唯一账号，无法自动选择导入目标');
const scan = await scanCodexHome(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'));
const result = await store.update(data => mergeCodexRecords(data, state.users[0].id, scan));
console.log(JSON.stringify({ scannedFiles: scan.scannedFiles, skippedFiles: scan.skippedFiles, ...result }));
