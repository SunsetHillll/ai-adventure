import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { createAppServer } from '../server.mjs';
import { mergeCodexRecords } from '../lib/merge.mjs';
import { parseCodexFile } from '../lib/codex.mjs';
import { normalizeReport } from '../lib/analysis.mjs';

test('内部 Guardian 审查不作为用户使用记录，已导入记录会清理', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'usage-guardian-test-'));
  const file = path.join(dir, 'review.jsonl');
  const marker = 'The following is the Codex agent history whose request action you are assessing.';
  try {
    await writeFile(file, [
      { timestamp: '2026-10-11T08:00:00.000Z', type: 'session_meta', payload: { id: 'guardian-id' } },
      { timestamp: '2026-10-11T08:00:01.000Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: marker + ' Review this transcript.' }] } }
    ].map(row => JSON.stringify(row)).join('\n'));
    assert.equal(await parseCodexFile(file, 'Guardian review'), null);
    const project = { id: 'project-id', userId: 'owner', source: 'codex', kind: 'project', externalId: 'workspace:abc', note: '由 Codex 工作目录建立，可编辑名称和说明。' };
    const guardian = { id: 'guardian-id', userId: 'owner', source: 'codex', kind: 'conversation', projectId: project.id, importedTitle: 'Guardian review', title: 'Guardian review', preview: marker };
    const state = { records: [project, guardian] };
    const result = mergeCodexRecords(state, 'owner', { records: [], projects: [], projectCatalogAvailable: false });
    assert.equal(result.removed, 1);
    assert.equal(result.projectsRemoved, 1);
    assert.equal(state.records.length, 0);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('旧版未命名记录会补齐标题，手动改过的标题保持不变', () => {
  const userId = 'owner';
  const old = { id: 'old-record', userId, source: 'codex', externalId: 'thread-1', title: '未命名 Codex 会话', startedAt: '2026-10-11T08:00:00.000Z', lastActiveAt: '2026-10-11T08:00:00.000Z', messageCount: 1 };
  const state = { records: [old] };
  const item = { externalId: 'thread-1', source: 'codex', title: '可读的会话名称', preview: '具体用户需求', startedAt: old.startedAt, lastActiveAt: old.lastActiveAt, messageCount: 2, codexProjectId: null, aiDurationMs: 0, completedTurns: 0, incompleteTurns: 0, tokenUsage: null, turns: [] };
  assert.equal(mergeCodexRecords(state, userId, { records: [item] }).updated, 1);
  assert.equal(old.title, '可读的会话名称');
  assert.equal(old.preview, '具体用户需求');
  old.title = '用户自己命名'; old.titleEdited = true;
  mergeCodexRecords(state, userId, { records: [{ ...item, title: '索引改名' }] });
  assert.equal(old.title, '用户自己命名');
});

test('旧文件夹项目迁移到 Codex 项目名并保留对话关系', () => {
  const userId = 'owner';
  const root = path.join(os.tmpdir(), 'old-folder');
  const key = createHash('sha256').update(path.normalize(root).toLowerCase()).digest('hex');
  const project = { id: 'existing-project', userId, source: 'codex', kind: 'project', externalId: `workspace:${key}`, title: 'old-folder', note: '由 Codex 工作目录建立，可编辑名称和说明。', startedAt: '2026-10-11T08:00:00.000Z', lastActiveAt: '2026-10-11T08:00:00.000Z' };
  const conversation = { id: 'existing-conversation', userId, source: 'codex', kind: 'conversation', externalId: 'thread-1', projectId: project.id, title: '已有对话', importedTitle: '已有对话', startedAt: project.startedAt, lastActiveAt: project.lastActiveAt };
  const state = { records: [project, conversation] };
  const item = { externalId: 'thread-1', source: 'codex', title: '已有对话', preview: '讨论开发', startedAt: project.startedAt, lastActiveAt: project.lastActiveAt, messageCount: 1, codexProjectId: 'codex-1', aiDurationMs: 1000, completedTurns: 1, incompleteTurns: 0, tokenUsage: { total_tokens: 30 }, turns: [] };
  const scan = { records: [item], projects: [{ externalId: 'codex-project:codex-1', codexProjectId: 'codex-1', title: '真实项目名', workspaceKeys: [key], missingReason: null, createdAt: project.startedAt }], projectCatalogAvailable: true };
  const result = mergeCodexRecords(state, userId, scan);
  assert.equal(result.projectsAdded, 0);
  assert.equal(project.id, 'existing-project');
  assert.equal(project.title, '真实项目名');
  assert.equal(project.externalId, 'codex-project:codex-1');
  assert.equal(conversation.projectId, project.id);
  assert.equal(state.records.length, 2);
  project.title = '我手动改的名称'; project.titleEdited = true;
  mergeCodexRecords(state, userId, { ...scan, projects: [{ ...scan.projects[0], title: 'Codex 新名称' }] });
  assert.equal(project.title, '我手动改的名称');
});

test('账号隔离入口、记录维护与 Codex 同步去重', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'usage-test-'));
  const codexHome = path.join(dir, 'codex');
  const sessions = path.join(codexHome, 'sessions', '2026', '10', '11');
  await mkdir(sessions, { recursive: true });
  const projectPath = path.join(dir, 'sample-project');
  await mkdir(projectPath);
  const file = path.join(sessions, 'rollout-test.jsonl');
  const usage = (input, output, cached = 0) => ({ input_tokens: input, cached_input_tokens: cached, cache_write_input_tokens: 0, output_tokens: output, reasoning_output_tokens: 0, total_tokens: input + output });
  const rows = [
    { timestamp: '2026-10-11T08:00:00.000Z', type: 'session_meta', payload: { id: 'test-thread', cwd: projectPath } },
    { timestamp: '2026-10-11T08:00:00.500Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>internal context</environment_context>' }] } },
    { timestamp: '2026-10-11T08:00:01.000Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<in-app-browser-context source="ambient-ui-state">浏览器状态</in-app-browser-context>\n# Files pasted by the user:\n## "文档": C:\\docs\\file.txt\n## My request: 帮我整理产品需求。' }] } },
    { timestamp: '2026-10-11T08:00:02.000Z', type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-1' } },
    { timestamp: '2026-10-11T08:01:00.000Z', type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: usage(1100, 20, 30), last_token_usage: usage(100, 20, 30) } } },
    { timestamp: '2026-10-11T08:03:00.000Z', type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn-1', duration_ms: 178000 } },
    { timestamp: '2026-10-11T08:03:30.000Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '1，提取目标。 2，检查结果。' }] } },
    { timestamp: '2026-10-11T08:04:00.000Z', type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-2' } },
    { timestamp: '2026-10-11T08:04:30.000Z', type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: usage(1130, 30, 40), last_token_usage: usage(30, 10, 10) } } },
    { timestamp: '2026-10-11T08:05:00.000Z', type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn-2', duration_ms: 60000 } },
    { timestamp: '2026-10-11T08:05:01.000Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '一段不应导入的回答正文' }] } },
    { timestamp: '2026-10-11T08:06:00.000Z', type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-3' } },
    { timestamp: '2026-10-11T08:06:20.000Z', type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: usage(1145, 35, 45), last_token_usage: usage(15, 5, 5) } } }
  ];
  await writeFile(file, rows.map(row => JSON.stringify(row)).join('\n'));
  await writeFile(path.join(codexHome, 'session_index.jsonl'), JSON.stringify({ id: 'test-thread', thread_name: '整理产品需求文档' }));
  await writeFile(path.join(codexHome, '.codex-global-state.json'), JSON.stringify({
    'local-projects': { 'project-1': { id: 'project-1', name: '产品计划', rootPaths: [projectPath], createdAt: Date.parse('2026-10-11T07:00:00.000Z') } },
    'thread-project-assignments': { 'test-thread': { projectKind: 'local', projectId: 'project-1' } }
  }));
  const dataFile = path.join(dir, 'data.json');
  let holdAnalysis = false;
  let failAnalysis = false;
  let resumeAnalysis;
  let analysisStarted;
  const enteredAnalysis = new Promise(resolve => { analysisStarted = resolve; });
  const server = createAppServer({ dataFile, codexHome, analyze: async input => {
    if (holdAnalysis) {
      holdAnalysis = false;
      analysisStarted();
      await new Promise(resolve => { resumeAnalysis = resolve; });
    }
    if (failAnalysis) { failAnalysis = false; throw new Error('request timed out'); }
    return normalizeReport(input.kind === 'project' ? {
    kind:'project', summary:'已整理需求，尚待验收。', progress:65,
    conversations: input.conversations.map(item => ({ id:item.id, progress:65, summary:'部分完成', milestones:[{title:'整理产品需求',status:'部分完成',progress:65,difficulty:'中',roi:'无法判断',turnIds:[item.turns[0].id]}] })),
    learning:[{skill:'需求分析',level:'实践',evidence:'用户提出并调整了需求'}]
    } : { kind:'week', summary:'本周推进了产品需求。', achievements:['形成需求草案'], gaps:['待验收'], nextWeek:['核对需求'], recommendations:['优先验收交付'] }, input);
  } });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  let cookie = '';
  async function request(route, method = 'GET', body, auth = true) {
    const response = await fetch(origin + route, {
      method,
      headers: { Origin: origin, ...(auth && cookie ? { Cookie: cookie } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined
    });
    const setCookie = response.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];
    return { status: response.status, data: await response.json() };
  }
  try {
    assert.equal((await request('/api/session')).data.setupRequired, true);
    assert.equal((await request('/api/records')).status, 401);
    const setup = await request('/api/setup', 'POST', { username: 'owner', password: 'secure-pass-123' });
    assert.equal(setup.status, 201);
    assert.equal(setup.data.user.username, 'owner');
    assert.match(cookie, new RegExp(`^usage_session_${server.address().port}=`));
    assert.equal((await request('/api/setup', 'POST', { username: 'another', password: 'secure-pass-123' })).status, 409);
    assert.equal((await request('/api/records')).data.records.length, 0);

    const created = await request('/api/records', 'POST', {
      title: '手动记录', startedAt: '2026-10-11T09:00:00.000Z', durationMinutes: 20,
      category: '产品开发', status: '进行中', note: '明确了目标'
    });
    assert.equal(created.status, 201);
    const edited = await request(`/api/records/${created.data.record.id}`, 'PATCH', {
      source: 'manual', title: '已完成的记录', startedAt: '2026-10-11T09:00:00.000Z', durationMinutes: 25,
      category: '产品开发', status: '已完成', note: '交付完成'
    });
    assert.equal(edited.data.record.status, '已完成');
    assert.equal(edited.data.record.durationMinutes, 25);

    const sync = await request('/api/codex/sync', 'POST', {});
    assert.equal(sync.status, 200);
    assert.equal(sync.data.added, 1);
    assert.equal(sync.data.projectsAdded, 1);
    const records = (await request('/api/records')).data.records;
    const project = records.find(record => record.kind === 'project');
    const imported = records.find(record => record.kind === 'conversation' && record.source === 'codex');
    assert.equal(imported.externalId, 'test-thread');
    assert.equal(imported.title, '整理产品需求文档');
    assert.equal(imported.preview, '帮我整理产品需求。');
    assert.equal(project.title, '产品计划');
    assert.equal(project.externalId, 'codex-project:project-1');
    assert.equal(imported.projectId, project.id);
    assert.equal(imported.messageCount, 2);
    assert.equal(imported.aiDurationMs, 238000);
    assert.equal(imported.completedTurns, 2);
    assert.equal(imported.incompleteTurns, 1);
    assert.equal(imported.tokenUsage.total_tokens, 180);
    assert.equal(imported.turns[0].usage.total_tokens, 120);
    assert.equal(imported.turns[0].objective, '帮我整理产品需求。');
    assert.deepEqual(imported.turns[1].targets, [{ id: 'turn-2', title: '提取目标。' }, { id: 'turn-2:2', title: '检查结果。' }]);
    assert.equal(imported.turns[1].usage.total_tokens, 40);
    assert.equal(imported.turns[2].durationMs, null);
    assert.equal(imported.turns[2].usage.total_tokens, 20);
    assert.equal(imported.durationMinutes, null);
    assert.equal(imported.status, '待回顾');
    const projectRequest = { kind:'project', projectId:project.id };
    assert.equal((await request('/api/analysis', 'POST', projectRequest)).status, 403);
    const projectPreview = await request(`/api/analysis/preview?kind=project&projectId=${project.id}`);
    assert.equal(projectPreview.status, 200);
    assert.equal(projectPreview.data.input.project.title, '产品计划');
    assert.equal(projectPreview.data.input.conversations.length, 1);
    assert.equal((await request('/api/analysis', 'POST', { ...projectRequest, consent:true, sourceHash:'outdated' })).status, 409);
    holdAnalysis = true;
    const analysisPromise = request('/api/analysis', 'POST', { ...projectRequest, consent:true, sourceHash:projectPreview.data.sourceHash });
    await enteredAnalysis;
    const running = await request('/api/analysis/status');
    assert.equal(running.data.active.title, '产品计划');
    assert.equal(running.data.active.phase, 'evaluating');
    assert.equal(running.data.active.conversationCount, 1);
    assert.equal(running.data.active.turnCount, 3);
    assert.equal((await request('/api/analysis', 'POST', { ...projectRequest, consent:true, sourceHash:projectPreview.data.sourceHash })).status, 409);
    resumeAnalysis();
    const analysis = await analysisPromise;
    assert.equal(analysis.status, 200);
    const completedRun = (await request('/api/analysis/status')).data.last;
    assert.equal(completedRun.status, 'completed');
    assert.equal(completedRun.phase, 'completed');
    assert.equal(analysis.data.report.conversations[0].milestones[0].title, '整理产品需求');
    assert.equal((await request('/api/records')).data.records.find(record => record.id === project.id).analysisStale, false);
    const weekRequest = { kind:'week', date:'2026-10-11' };
    const weekPreview = await request('/api/analysis/preview?kind=week&date=2026-10-11');
    assert.equal(weekPreview.status, 200);
    const week = await request('/api/analysis', 'POST', { ...weekRequest, consent:true, sourceHash:weekPreview.data.sourceHash });
    assert.equal(week.status, 200);
    assert.equal((await request('/api/records')).data.reports.length, 1);
    failAnalysis = true;
    assert.equal((await request('/api/analysis', 'POST', { ...weekRequest, consent:true, sourceHash:weekPreview.data.sourceHash })).status, 504);
    const failedRun = (await request('/api/analysis/status')).data.last;
    assert.equal(failedRun.status, 'failed');
    assert.equal(failedRun.phase, 'failed');
    assert.equal(failedRun.failureReason, 'timeout');
    assert.equal((await request('/api/records')).data.reports.length, 1);
    const defeated = await request(`/api/records/${imported.id}/targets/turn-1`, 'PATCH', { defeated: true });
    assert.equal(defeated.status, 200);
    assert.equal(defeated.data.record.targetOutcomes['turn-1'], true);
    assert.equal((await request('/api/records')).data.records.find(record => record.id === project.id).analysisStale, true);
    assert.equal((await request(`/api/records/${imported.id}/targets/turn-2%3A2`, 'PATCH', { defeated: true })).status, 200);
    assert.equal((await request(`/api/records/${imported.id}/targets/turn-3`, 'PATCH', { defeated: true })).status, 400);
    const task = await request('/api/records', 'POST', {
      kind: 'task', projectId: project.id, title: '核对需求', startedAt: '2026-10-11T09:20:00.000Z',
      durationMinutes: null, category: '产品开发', status: '进行中', note: ''
    });
    assert.equal(task.status, 201);
    assert.equal(task.data.record.projectId, project.id);
    const linked = await request(`/api/records/${imported.id}`, 'PATCH', {
      source: 'codex', kind: 'conversation', title: imported.title, note: '',
      category: '产品开发', status: '进行中', projectId: project.id, taskId: task.data.record.id
    });
    assert.equal(linked.data.record.taskId, task.data.record.id);
    const repeated = await request('/api/codex/sync', 'POST', {});
    assert.equal(repeated.data.added, 0);
    assert.equal(repeated.data.updated, 0);
    assert.equal((await request('/api/records')).data.records.find(record => record.id === imported.id).targetOutcomes['turn-1'], true);
    assert.equal((await request(`/api/records/${imported.id}/targets/turn-1`, 'PATCH', { defeated: false })).status, 200);
    await rm(projectPath, { recursive: true });
    assert.equal((await request('/api/codex/sync', 'POST', {})).data.projectsUpdated, 1);
    assert.equal((await request('/api/records')).data.records.find(record => record.id === project.id).missingReason, 'directory');
    await writeFile(path.join(codexHome, '.codex-global-state.json'), JSON.stringify({ 'local-projects': {}, 'thread-project-assignments': {} }));
    await request('/api/codex/sync', 'POST', {});
    assert.equal((await request('/api/records')).data.records.find(record => record.id === project.id).missingReason, 'codex');
    const backup = await request('/api/export');
    assert.equal(backup.data.records.length, 4);
    assert.ok(backup.data.records.every(record => !('userId' in record)));
    await request(`/api/records/${imported.id}`, 'DELETE');
    await request('/api/codex/sync', 'POST', {});
    assert.equal((await request('/api/records')).data.records.length, 3);

    const saved = await readFile(dataFile, 'utf8');
    assert.ok(!saved.includes('secure-pass-123'));
    assert.ok(!saved.includes('一段不应导入的回答正文'));
    assert.equal((await request('/api/logout', 'POST', {})).status, 200);
    assert.equal((await request('/api/records')).status, 401);
    assert.equal((await request('/api/login', 'POST', { username: 'owner', password: 'secure-pass-123' })).status, 200);
    assert.equal((await request('/api/records')).data.records.length, 3);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
});
