import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { randomBytes, randomUUID, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JsonStore } from './lib/store.mjs';
import { scanCodexHome } from './lib/codex.mjs';
import { mergeCodexRecords } from './lib/merge.mjs';
import { projectInput, weekInput, sourceHash, runAnalysis } from './lib/analysis.mjs';

const scrypt = promisify(scryptCallback);
const root = path.dirname(fileURLToPath(import.meta.url));
const categories = new Set(['未分类', '产品开发', '内容创作', '研究学习', '问题排查', '其他']);
const statuses = new Set(['待回顾', '进行中', '待跟进', '已完成']);
const kinds = new Set(['project', 'task', 'conversation']);
const SESSION_MS = 7 * 24 * 60 * 60 * 1000;
const BODY_LIMIT = 64 * 1024;

function fail(status, message) {
  const error = new Error(message);
  error.status = status;
  throw error;
}

function json(res, status, body, headers = {}) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...headers
  });
  res.end(JSON.stringify(body));
}

async function bodyJson(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > BODY_LIMIT) fail(413, '请求内容过大');
    chunks.push(chunk);
  }
  let value;
  try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { fail(400, 'JSON 格式错误'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(400, '请求内容格式错误');
  return value;
}

function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) fail(403, '缺少同源请求信息');
  try {
    const parsed = new URL(origin);
    if (parsed.protocol !== 'http:' || parsed.host !== req.headers.host) fail(403, '跨站请求已拒绝');
  } catch { fail(403, '跨站请求已拒绝'); }
}

function validIso(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function analysisInput(request, records) {
  if (request.kind === 'project') {
    const project = records.find(record => record.id === request.projectId && record.kind === 'project');
    if (!project) fail(404, '项目不存在');
    const input = projectInput(project, records);
    if (!input.conversations.length) fail(400, '这项行动尚无可评估的执行阶段');
    return input;
  }
  if (request.kind === 'week') {
    if (typeof request.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(request.date) || !validIso(`${request.date}T12:00:00`)) fail(400, '日期无效');
    const start = new Date(`${request.date}T00:00:00`);
    start.setDate(start.getDate() - ((start.getDay() + 6) % 7));
    const end = new Date(start); end.setDate(end.getDate() + 7);
    const input = weekInput(start.toISOString(), end.toISOString(), records);
    if (!input.conversations.length) fail(400, '本周尚无可评估的 Codex 执行轮次');
    return input;
  }
  fail(400, '评估范围无效');
}

function cleanText(value, limit, required = false) {
  if (typeof value !== 'string') fail(400, '文本字段格式错误');
  const text = value.trim();
  if ((required && !text) || text.length > limit) fail(400, '文本长度不符合要求');
  return text;
}

function publicUser(user) {
  return { id: user.id, username: user.username, createdAt: user.createdAt };
}

function relationIds(state, userId, kind, projectId, taskId) {
  if (kind === 'project') return { projectId: null, taskId: null };
  const project = projectId ? state.records.find(r => r.id === projectId && r.userId === userId && !r.hidden && r.kind === 'project') : null;
  if (projectId && !project) fail(400, '所属项目不存在');
  if (kind === 'task') return { projectId: project?.id || null, taskId: null };
  const task = taskId ? state.records.find(r => r.id === taskId && r.userId === userId && !r.hidden && r.kind === 'task') : null;
  if (taskId && !task) fail(400, '所属任务不存在');
  if (task?.projectId && project && task.projectId !== project.id) fail(400, '任务与项目不匹配');
  return { projectId: project?.id || task?.projectId || null, taskId: task?.id || null };
}

function sessionCookieName(req) {
  const port = new URL(`http://${req.headers.host || 'localhost'}`).port || '80';
  return `usage_session_${port}`;
}

function cookie(req, token, maxAge = Math.floor(SESSION_MS / 1000)) {
  return `${sessionCookieName(req)}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}`;
}

function sessionToken(req) {
  const name = sessionCookieName(req);
  return (req.headers.cookie || '').split(';').map(part => part.trim()).find(part => part.startsWith(`${name}=`))?.slice(name.length + 1) || null;
}

export function createAppServer({
  dataFile = path.join(root, 'data', 'app.json'),
  codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex'),
  analyze = runAnalysis
} = {}) {
  const store = new JsonStore(dataFile);
  const sessions = new Map();
  const failures = new Map();
  let analyzing = null;

  function sessionUser(req, state) {
    const token = sessionToken(req);
    if (!token) return null;
    const session = sessions.get(token);
    if (!session || session.expiresAt < Date.now()) return null;
    return state.users.find(user => user.id === session.userId) || null;
  }

  function createSession(req, res, user) {
    const token = randomBytes(32).toString('base64url');
    sessions.set(token, { userId: user.id, expiresAt: Date.now() + SESSION_MS });
    res.setHeader('Set-Cookie', cookie(req, token));
  }

  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      const pathname = url.pathname;
      if (pathname === '/' && req.method === 'GET') {
        const page = await readFile(path.join(root, 'index.html'));
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
        res.end(page);
        return;
      }
      if (req.method === 'GET' && ['/adventure.css', '/adventure.js', '/game-world.mjs', '/sound.js'].includes(pathname)) {
        const assetPath = pathname === '/game-world.mjs' ? path.join(root, 'lib', 'game-world.mjs') : path.join(root, pathname.slice(1));
        const asset = await readFile(assetPath);
        res.writeHead(200, {
          'Content-Type': pathname.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/javascript; charset=utf-8',
          'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff'
        });
        res.end(asset);
        return;
      }
      if (!pathname.startsWith('/api/')) return json(res, 404, { error: '页面不存在' });
      if (!['GET', 'HEAD'].includes(req.method)) sameOrigin(req);

      if (pathname === '/api/session' && req.method === 'GET') {
        const state = await store.read();
        const user = sessionUser(req, state);
        return json(res, 200, { setupRequired: state.users.length === 0, user: user ? publicUser(user) : null });
      }

      if (pathname === '/api/setup' && req.method === 'POST') {
        const input = await bodyJson(req);
        if (!input || typeof input !== 'object') fail(400, '请求内容格式错误');
        const username = cleanText(input.username, 32, true);
        const password = input.password;
        if (typeof password !== 'string' || password.length > 200) fail(400, '密码格式错误');
        if (username.length < 2 || password.length < 8) fail(400, '用户名至少 2 字，密码至少 8 字');
        const salt = randomBytes(16).toString('hex');
        const hash = (await scrypt(password, salt, 64)).toString('hex');
        const user = await store.update(state => {
          if (state.users.length) fail(409, '账号已经创建，请登录');
          const created = { id: randomUUID(), username, salt, passwordHash: hash, createdAt: new Date().toISOString() };
          state.users.push(created);
          return created;
        });
        createSession(req, res, user);
        return json(res, 201, { user: publicUser(user) });
      }

      if (pathname === '/api/login' && req.method === 'POST') {
        const input = await bodyJson(req);
        const key = req.socket.remoteAddress || 'local';
        const limit = failures.get(key);
        if (limit && limit.count >= 5 && limit.until > Date.now()) fail(429, '尝试过多，请稍后再试');
        const state = await store.read();
        const user = state.users.find(item => item.username === input.username);
        const salt = user?.salt || '00000000000000000000000000000000';
        const expected = Buffer.from(user?.passwordHash || '00'.repeat(64), 'hex');
        const actual = await scrypt(String(input.password || ''), salt, 64);
        if (!user || !timingSafeEqual(expected, actual)) {
          failures.set(key, { count: (limit?.until > Date.now() ? limit.count : 0) + 1, until: Date.now() + 15 * 60 * 1000 });
          fail(401, '用户名或密码错误');
        }
        failures.delete(key);
        createSession(req, res, user);
        return json(res, 200, { user: publicUser(user) });
      }

      const state = await store.read();
      const user = sessionUser(req, state);
      if (!user) fail(401, '请先登录');

      if (pathname === '/api/logout' && req.method === 'POST') {
        const token = sessionToken(req);
        if (token) sessions.delete(token);
        res.setHeader('Set-Cookie', cookie(req, '', 0));
        return json(res, 200, { ok: true });
      }

      if (pathname === '/api/records' && req.method === 'GET') {
        const records = state.records.filter(record => record.userId === user.id && !record.hidden)
          .sort((a, b) => b.startedAt.localeCompare(a.startedAt)).map(record => ({ ...record }));
        for (const record of records.filter(item => item.kind === 'project' && item.analysis)) {
          record.analysisStale = record.analysisSourceHash !== sourceHash(projectInput(record, records));
        }
        const reports = (state.reports || []).filter(report => report.userId === user.id).map(({ userId, ...report }) => ({
          ...report, stale: report.kind === 'week' && report.sourceHash !== sourceHash(weekInput(report.start, report.end, records))
        }));
        return json(res, 200, { records, reports });
      }

      if (pathname === '/api/export' && req.method === 'GET') {
        const records = state.records.filter(record => record.userId === user.id && !record.hidden)
          .map(({ userId, ...record }) => record);
        const reports = (state.reports || []).filter(report => report.userId === user.id).map(({ userId, ...report }) => report);
        return json(res, 200, { version: 1, exportedAt: new Date().toISOString(), username: user.username, records, reports });
      }

      if (pathname === '/api/analysis/preview' && req.method === 'GET') {
        const visible = state.records.filter(record => record.userId === user.id && !record.hidden);
        const input = analysisInput(Object.fromEntries(url.searchParams), visible);
        return json(res, 200, { input, sourceHash: sourceHash(input) });
      }

      if (pathname === '/api/analysis/status' && req.method === 'GET') {
        const visible = job => job?.userId === user.id ? {
          kind: job.kind, projectId: job.projectId, title: job.title,
          conversationCount: job.conversationCount, turnCount: job.turnCount,
          startedAt: job.startedAt, finishedAt: job.finishedAt, status: job.status, phase: job.phase || null,
          failureReason: job.failureReason || null
        } : null;
        const saved = state.analysisActivity?.[user.id] || null;
        const last = saved?.status === 'running' && !analyzing ? { ...saved, status:'interrupted' } : saved;
        return json(res, 200, { active: visible(analyzing), last: last?.status === 'running' ? null : visible(last) });
      }

      if (pathname === '/api/analysis' && req.method === 'POST') {
        if (analyzing) fail(409, '上一项评估仍在执行，请稍后');
        const request = await bodyJson(req);
        const visible = state.records.filter(record => record.userId === user.id && !record.hidden);
        const input = analysisInput(request, visible);
        if (request.consent !== true || typeof request.sourceHash !== 'string') fail(403, '请先查看本次发送内容并明确同意');
        if (request.sourceHash !== sourceHash(input)) fail(409, '记录已变化，请重新查看发送内容');
        const job = {
          userId: user.id, kind: input.kind, projectId: input.project?.id || null,
          title: input.project?.title || `${input.start.slice(0, 10)} 至 ${input.end.slice(0, 10)} 周复盘`,
          conversationCount: input.conversations.length,
          turnCount: input.conversations.reduce((count, record) => count + record.turns.length, 0),
          startedAt: new Date().toISOString(), status: 'running', phase: 'preparing'
        };
        analyzing = job;
        try {
          await store.update(data => { data.analysisActivity ||= {}; data.analysisActivity[user.id] = job; });
          job.phase = 'evaluating';
          const report = await analyze(input);
          report.generatedAt = new Date().toISOString();
          report.sourceHash = sourceHash(input);
          job.phase = 'archiving';
          const completed = { ...job, status:'completed', phase:'completed', finishedAt:new Date().toISOString() };
          await store.update(data => {
            if (request.kind === 'project') {
              const project = data.records.find(record => record.id === request.projectId && record.userId === user.id && !record.hidden);
              if (!project) fail(404, '项目不存在');
              project.analysis = report;
              project.analysisSourceHash = report.sourceHash;
            } else {
              data.reports ||= [];
              data.reports = data.reports.filter(item => !(item.userId === user.id && item.kind === 'week' && item.start === report.start));
              data.reports.push({ ...report, userId: user.id });
            }
            data.analysisActivity ||= {};
            data.analysisActivity[user.id] = completed;
          });
          return json(res, 200, { report });
        } catch (error) {
          const timedOut = /timed out|timeout|超时/i.test(error.message);
          const failed = { ...job, status:'failed', phase:'failed', finishedAt:new Date().toISOString(), failureReason: timedOut ? 'timeout' : 'model_error' };
          try { await store.update(data => { data.analysisActivity ||= {}; data.analysisActivity[user.id] = failed; }); } catch { /* 保留原始错误。 */ }
          if (timedOut) fail(504, 'Codex 连接超时，本次评估未归档；请稍后重试');
          if (!error.status) fail(502, '行动评估失败，结论未归档；请检查 Codex 登录与网络');
          throw error;
        } finally { analyzing = null; }
      }

      if (pathname === '/api/records' && req.method === 'POST') {
        const input = await bodyJson(req);
        const title = cleanText(input.title, 160, true);
        if (!validIso(input.startedAt)) fail(400, '时间格式错误');
        const kind = input.kind || 'conversation';
        if (!kinds.has(kind)) fail(400, '记录类型无效');
        const durationMinutes = input.durationMinutes == null || input.durationMinutes === '' || kind === 'project' ? null : Number(input.durationMinutes);
        if (durationMinutes != null && (!Number.isInteger(durationMinutes) || durationMinutes < 1 || durationMinutes > 999)) fail(400, '时长应为 1 至 999 分钟');
        if (!categories.has(input.category) || !statuses.has(input.status)) fail(400, '分类或状态无效');
        const note = cleanText(input.note || '', 2000);
        const record = await store.update(data => {
          const links = relationIds(data, user.id, kind, input.projectId || null, input.taskId || null);
          const created = {
            id: randomUUID(), userId: user.id, source: 'manual', externalId: null, kind, ...links,
            title, startedAt: new Date(input.startedAt).toISOString(), lastActiveAt: new Date(input.startedAt).toISOString(),
            durationMinutes, durationEstimated: false, messageCount: null,
            category: input.category, status: input.status, note,
            createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
          };
          data.records.push(created);
          return created;
        });
        return json(res, 201, { record });
      }

      const recordMatch = /^\/api\/records\/([0-9a-f-]{36})$/.exec(pathname);
      const targetMatch = /^\/api\/records\/([0-9a-f-]{36})\/targets\/([^/]+)$/.exec(pathname);
      if (targetMatch && req.method === 'PATCH') {
        const input = await bodyJson(req);
        if (typeof input.defeated !== 'boolean') fail(400, '目标状态无效');
        let turnId;
        try { turnId = decodeURIComponent(targetMatch[2]); } catch { fail(400, '目标编号无效'); }
        if (!turnId || turnId.length > 200 || ['__proto__', 'constructor', 'prototype'].includes(turnId)) fail(400, '目标编号无效');
        const record = await store.update(data => {
          const current = data.records.find(item => item.id === targetMatch[1] && item.userId === user.id && !item.hidden);
          if (!current || current.source !== 'codex' || current.kind !== 'conversation') fail(404, '执行阶段不存在');
          const turn = current.turns?.find(item => item.id === turnId || item.targets?.some(target => target.id === turnId));
          if (!turn || !turn.completedAt) fail(400, '目标尚不能确认');
          current.targetOutcomes ||= {};
          if (input.defeated) current.targetOutcomes[turnId] = true;
          else delete current.targetOutcomes[turnId];
          current.updatedAt = new Date().toISOString();
          return current;
        });
        return json(res, 200, { record });
      }
      if (recordMatch && req.method === 'PATCH') {
        const input = await bodyJson(req);
        const title = cleanText(input.title, 160, true);
        const note = cleanText(input.note || '', 2000);
        if (!categories.has(input.category) || !statuses.has(input.status)) fail(400, '分类或状态无效');
        let durationMinutes = null;
        let startedAt = null;
        if (input.source === 'manual') {
          durationMinutes = input.durationMinutes == null || input.durationMinutes === '' || input.kind === 'project' ? null : Number(input.durationMinutes);
          if ((durationMinutes != null && (!Number.isInteger(durationMinutes) || durationMinutes < 1 || durationMinutes > 999)) || !validIso(input.startedAt)) fail(400, '时长或时间无效');
          startedAt = new Date(input.startedAt).toISOString();
        }
        const record = await store.update(data => {
          const current = data.records.find(item => item.id === recordMatch[1] && item.userId === user.id && !item.hidden);
          if (!current) fail(404, '记录不存在');
          if (current.source !== input.source) fail(400, '记录来源不可修改');
          const kind = current.kind || 'conversation';
          if (input.kind && input.kind !== kind) fail(400, '记录类型不可修改');
          const links = relationIds(data, user.id, kind, input.projectId || null, input.taskId || null);
          if (current.source === 'codex' && current.title !== title) current.titleEdited = true;
          if (current.source === 'codex' && current.kind === 'conversation' && current.projectId !== links.projectId) current.projectEdited = true;
          Object.assign(current, { kind, ...links, title, note, category: input.category, status: input.status, updatedAt: new Date().toISOString() });
          if (current.source === 'manual') Object.assign(current, { startedAt, lastActiveAt: startedAt, durationMinutes });
          return current;
        });
        return json(res, 200, { record });
      }

      if (recordMatch && req.method === 'DELETE') {
        await store.update(data => {
          const index = data.records.findIndex(item => item.id === recordMatch[1] && item.userId === user.id && !item.hidden);
          if (index < 0) fail(404, '记录不存在');
          const deleted = data.records[index];
          if (deleted.kind === 'project') data.records.filter(r => r.userId === user.id && r.projectId === deleted.id).forEach(r => { r.projectId = null; });
          if (deleted.kind === 'task') data.records.filter(r => r.userId === user.id && r.taskId === deleted.id).forEach(r => { r.taskId = null; });
          if (deleted.source === 'codex') deleted.hidden = true;
          else data.records.splice(index, 1);
        });
        return json(res, 200, { ok: true });
      }

      if (pathname === '/api/codex/sync' && req.method === 'POST') {
        const scan = await scanCodexHome(codexHome);
        const result = await store.update(data => mergeCodexRecords(data, user.id, scan));
        return json(res, 200, { ...result, scannedFiles: scan.scannedFiles, skippedFiles: scan.skippedFiles });
      }

      return json(res, 404, { error: '接口不存在' });
    } catch (error) {
      const status = error.status || 500;
      if (status === 500) console.error(error);
      if (!res.headersSent) json(res, status, { error: status === 500 ? '服务器发生错误' : error.message });
      else res.end();
    }
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 4173);
  createAppServer().listen(port, '127.0.0.1', () => {
    console.log(`AI 使用记录已启动：http://127.0.0.1:${port}`);
  });
}
