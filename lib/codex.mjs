import { createReadStream } from 'node:fs';
import { readFile, readdir, stat } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { createHash } from 'node:crypto';
import path from 'node:path';

const MAX_FILE_BYTES = 60 * 1024 * 1024;
const usageFields = ['input_tokens', 'cached_input_tokens', 'cache_write_input_tokens', 'output_tokens', 'reasoning_output_tokens', 'total_tokens'];

function readUsage(value) {
  if (!value || !Number.isSafeInteger(value.total_tokens) || value.total_tokens < 0) return null;
  return Object.fromEntries(usageFields.map(field => [field, Number.isSafeInteger(value[field]) && value[field] >= 0 ? value[field] : 0]));
}

function usageDifference(after, before) {
  if (!after) return null;
  const baseline = before || Object.fromEntries(usageFields.map(field => [field, 0]));
  if (after.total_tokens < baseline.total_tokens) return null;
  return Object.fromEntries(usageFields.map(field => [field, Math.max(0, after[field] - baseline[field])]));
}

function addUsage(left, right) {
  if (!right) return left;
  return Object.fromEntries(usageFields.map(field => [field, (left?.[field] || 0) + right[field]]));
}

function workspaceKey(cwd) {
  return createHash('sha256').update(path.normalize(cwd).toLowerCase()).digest('hex');
}

async function readProjectState(home) {
  let state;
  try { state = JSON.parse(await readFile(path.join(home, '.codex-global-state.json'), 'utf8')); }
  catch { return { available: false, projects: [], assignments: {} }; }
  const localProjects = state['local-projects'];
  const assignments = state['thread-project-assignments'];
  if (!localProjects || typeof localProjects !== 'object' || Array.isArray(localProjects)) return { available: false, projects: [], assignments: {} };
  const projects = await Promise.all(Object.values(localProjects).filter(project => project?.id && project?.name).map(async project => {
    const rootPaths = Array.isArray(project.rootPaths) ? project.rootPaths.filter(value => typeof value === 'string' && value) : [];
    const rootsAvailable = await Promise.all(rootPaths.map(async root => {
      try { return (await stat(root)).isDirectory(); } catch { return false; }
    }));
    return {
      externalId: `codex-project:${project.id}`,
      codexProjectId: project.id,
      title: String(project.name).trim().slice(0, 160),
      rootPaths,
      workspaceKeys: rootPaths.map(workspaceKey),
      missingReason: rootPaths.length && !rootsAvailable.some(Boolean) ? 'directory' : null,
      createdAt: Number.isFinite(project.createdAt) ? new Date(project.createdAt).toISOString() : null,
      updatedAt: Number.isFinite(project.updatedAt) ? new Date(project.updatedAt).toISOString() : null
    };
  }));
  return { available: true, projects: projects.filter(project => project.title), assignments: assignments && typeof assignments === 'object' ? assignments : {} };
}

async function collectJsonl(directory, results) {
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); }
  catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  for (const entry of entries) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) await collectJsonl(file, results);
    else if (entry.isFile() && entry.name.endsWith('.jsonl')) results.push(file);
  }
}

function cleanPrompt(text) {
  return String(text || '')
    .replace(/<environment_context>[\s\S]*?<\/environment_context>/g, ' ')
    .replace(/<external_codex_apps_open_page>[\s\S]*?<\/external_codex_apps_open_page>/g, ' ')
    .replace(/<in-app-browser-context\b[^>]*>[\s\S]*?<\/in-app-browser-context>/g, ' ')
    .replace(/<send_user_message_question_reply>[\s\S]*?<\/send_user_message_question_reply>/g, ' ')
    .replace(/<image\b[^>]*>[\s\S]*?<\/image>/g, ' ')
    .replace(/# Files (?:mentioned|pasted) by the user:[\s\S]*?## My request:/g, ' ')
    .replace(/## My request:\s*/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

function displayTitle(text) {
  return cleanPrompt(text).slice(0, 160) || '未命名 Codex 会话';
}

function objectiveTargets(text, turnId) {
  if (/^(继续|接着做|继续做|继续开发|开始吧|好的|好|ok|okay|yes|这一轮做完了嘛)[。！!？?\s]*$/i.test(text.trim())) return [];
  const markers = [...text.matchAll(/(?:^|[\s：:。；;])([1-8])[、，,.．)）]\s*/g)];
  const numbered = markers.length >= 2 && markers[0][1] === '1'
    && markers.slice(1).every((match, index) => Number(match[1]) === index + 2);
  const parts = numbered ? markers.map((match, index) => text.slice(match.index + match[0].length, markers[index + 1]?.index ?? text.length)) : [text];
  return parts.slice(0, 8).map((part, index) => ({
    id: index ? `${turnId}:${index + 1}` : turnId,
    title: part.trim().slice(0, 180)
  })).filter(target => target.title);
}

function attachObjective(turn, text) {
  const targets = objectiveTargets(text, turn.id);
  turn.objective = text.slice(0, 180);
  turn.targets = targets;
}

function resultExcerpt(parts) {
  return (Array.isArray(parts) ? parts : []).filter(part => part?.type === 'output_text')
    .map(part => String(part.text || '')).join(' ').replace(/\s+/g, ' ').trim().slice(0, 1200);
}

async function readThreadNames(home) {
  const names = new Map();
  const file = path.join(home, 'session_index.jsonl');
  try {
    const lines = createInterface({ input: createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
    for await (const line of lines) {
      try {
        const row = JSON.parse(line);
        if (row.id && typeof row.thread_name === 'string' && row.thread_name.trim()) names.set(row.id, row.thread_name.trim());
      } catch { /* Skip malformed index lines. */ }
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  return names;
}

export async function parseCodexFile(file, indexedTitle = '') {
  let id = '';
  let startedAt = '';
  let lastActiveAt = '';
  let firstPrompt = '';
  let messageCount = 0;
  let rawUserCount = 0;
  let cwd = '';
  let lastCumulativeUsage = null;
  let sessionUsage = null;
  let pendingObjective = '';
  const turns = new Map();
  let activeTurnId = null;
  const lines = createInterface({ input: createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of lines) {
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    const at = row.timestamp;
    if (at && !startedAt) startedAt = at;
    if (at) lastActiveAt = at;
    if (row.type === 'session_meta') {
      id = row.payload?.id || row.payload?.session_id || id;
      cwd = row.payload?.cwd || cwd;
    }
    if (row.type === 'event_msg') {
      const event = row.payload || {};
      if (event.type === 'task_started' && event.turn_id) {
        activeTurnId = event.turn_id;
        if (!turns.has(activeTurnId)) turns.set(activeTurnId, {
          id: activeTurnId, startedAt: at, completedAt: null, durationMs: null,
          usage: null, objective: '', targets: []
        });
        if (pendingObjective) attachObjective(turns.get(activeTurnId), pendingObjective);
        pendingObjective = '';
      } else if (event.type === 'token_count') {
        const cumulative = readUsage(event.info?.total_token_usage);
        const lastCall = readUsage(event.info?.last_token_usage);
        const increment = cumulative && lastCumulativeUsage && cumulative.total_tokens >= lastCumulativeUsage.total_tokens
          ? usageDifference(cumulative, lastCumulativeUsage) : lastCall;
        if (cumulative) lastCumulativeUsage = cumulative;
        if (increment?.total_tokens) {
          sessionUsage = addUsage(sessionUsage, increment);
          const active = turns.get(activeTurnId);
          if (active) active.usage = addUsage(active.usage, increment);
        }
      } else if (event.type === 'task_complete' && event.turn_id) {
        const turn = turns.get(event.turn_id) || {
          id: event.turn_id, startedAt: Number.isFinite(event.started_at) ? new Date(event.started_at * 1000).toISOString() : at,
          completedAt: null, durationMs: null, usage: null, objective: '', targets: []
        };
        if (pendingObjective && !turn.objective) attachObjective(turn, pendingObjective);
        pendingObjective = '';
        turn.completedAt = at;
        turn.durationMs = Number.isSafeInteger(event.duration_ms) && event.duration_ms >= 0 ? event.duration_ms : null;
        turns.set(event.turn_id, turn);
        if (activeTurnId === event.turn_id) activeTurnId = null;
      }
    }
    if (row.type === 'response_item' && row.payload?.type === 'message'
      && row.payload.role === 'assistant' && row.payload.phase === 'final_answer') {
      const result = resultExcerpt(row.payload.content);
      if (result && activeTurnId && turns.has(activeTurnId)) turns.get(activeTurnId).result = result;
    }
    if (row.type === 'response_item' && row.payload?.type === 'message' && row.payload.role === 'user') {
      const parts = row.payload.content || [];
      const prompt = parts.filter(p => p.type === 'input_text').map(p => p.text || '').join(' ').trim();
      if (prompt) rawUserCount++;
      const meaningful = cleanPrompt(prompt);
      if (meaningful) {
        messageCount++;
        if (!firstPrompt) firstPrompt = meaningful;
        // Keep only a short user-written objective for the next AI work turn.
        // A completed turn proves processing finished, not that the goal was solved.
        if (activeTurnId && turns.has(activeTurnId) && !turns.get(activeTurnId).objective) attachObjective(turns.get(activeTurnId), meaningful.slice(0, 5000));
        else pendingObjective = meaningful.slice(0, 5000);
      }
    }
  }
  if (!id || !startedAt || !Number.isFinite(Date.parse(startedAt)) || rawUserCount === 0 || (messageCount === 0 && !indexedTitle)) return null;
  if (indexedTitle === 'Guardian review' && firstPrompt.startsWith('The following is the Codex agent history whose request action you are assessing.')) return null;
  const turnList = [...turns.values()].map(turn => ({ id: turn.id, startedAt: turn.startedAt, completedAt: turn.completedAt, durationMs: turn.durationMs, usage: turn.usage, objective: turn.objective || '', targets: turn.targets || [], result: turn.result || '' }));
  return {
    externalId: id,
    source: 'codex',
    title: displayTitle(indexedTitle || firstPrompt),
    preview: firstPrompt.slice(0, 260),
    workspaceKey: cwd ? workspaceKey(cwd) : null,
    codexProjectId: null,
    startedAt: new Date(startedAt).toISOString(),
    lastActiveAt: Number.isFinite(Date.parse(lastActiveAt)) ? new Date(lastActiveAt).toISOString() : new Date(startedAt).toISOString(),
    messageCount: messageCount || rawUserCount,
    aiDurationMs: turnList.reduce((sum, turn) => sum + (turn.durationMs || 0), 0),
    completedTurns: turnList.filter(turn => turn.completedAt && turn.durationMs != null).length,
    incompleteTurns: turnList.filter(turn => !turn.completedAt || turn.durationMs == null).length,
    tokenUsage: sessionUsage,
    turns: turnList,
    durationMinutes: null,
    durationEstimated: false
  };
}

export async function scanCodexHome(home) {
  const threadNames = await readThreadNames(home);
  const projectState = await readProjectState(home);
  const files = [];
  await collectJsonl(path.join(home, 'sessions'), files);
  await collectJsonl(path.join(home, 'archived_sessions'), files);
  const byId = new Map();
  let skipped = 0;
  for (const file of files) {
    try {
      if ((await stat(file)).size > MAX_FILE_BYTES) { skipped++; continue; }
      const idFromName = /([0-9a-f]{8}-[0-9a-f-]{27,})\.jsonl$/i.exec(path.basename(file))?.[1];
      const record = await parseCodexFile(file, threadNames.get(idFromName) || '');
      if (record && threadNames.has(record.externalId)) record.title = displayTitle(threadNames.get(record.externalId));
      if (!record) { skipped++; continue; }
      const assignment = projectState.assignments[record.externalId];
      if (assignment?.projectKind === 'local' && projectState.projects.some(project => project.codexProjectId === assignment.projectId)) record.codexProjectId = assignment.projectId;
      const old = byId.get(record.externalId);
      if (!old || old.lastActiveAt < record.lastActiveAt) byId.set(record.externalId, record);
    } catch { skipped++; }
  }
  return { records: [...byId.values()], projects: projectState.projects, projectCatalogAvailable: projectState.available, scannedFiles: files.length, skippedFiles: skipped };
}
