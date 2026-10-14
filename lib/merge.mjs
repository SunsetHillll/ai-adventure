import { randomUUID } from 'node:crypto';

const oldWorkspaceNote = '由 Codex 工作目录建立，可编辑名称和说明。';

function isAutoWorkspaceProject(record, userId) {
  return record.userId === userId && record.source === 'codex' && record.kind === 'project'
    && record.externalId?.startsWith('workspace:');
}

export function mergeCodexRecords(data, userId, scan) {
  const records = scan.records || [];
  const catalogProjects = scan.projects || [];
  const now = new Date().toISOString();
  let added = 0;
  let updated = 0;
  let projectsAdded = 0;
  let projectsUpdated = 0;
  let removed = 0;
  let projectsRemoved = 0;

  data.records = data.records.filter(record => {
    const internal = record.userId === userId && record.source === 'codex' && record.kind === 'conversation'
      && (record.importedTitle === 'Guardian review' || record.title === 'Guardian review')
      && record.preview?.startsWith('The following is the Codex agent history whose request action you are assessing.')
      && !record.titleEdited && !record.note && (!record.category || record.category === '未分类')
      && (!record.status || record.status === '待回顾');
    if (internal) removed++;
    return !internal;
  });

  const projectByCodexId = new Map();
  for (const item of catalogProjects) {
    const legacyIds = new Set(item.workspaceKeys.map(key => `workspace:${key}`));
    let project = data.records.find(record => record.userId === userId && record.kind === 'project' && record.externalId === item.externalId);
    if (!project) project = data.records.find(record => isAutoWorkspaceProject(record, userId) && legacyIds.has(record.externalId));
    if (!project) {
      project = {
        id: randomUUID(), userId, source: 'codex', externalId: item.externalId, kind: 'project',
        projectId: null, taskId: null, title: item.title, importedTitle: item.title,
        startedAt: item.createdAt || now, lastActiveAt: item.updatedAt || item.createdAt || now,
        durationMinutes: null, durationEstimated: false, messageCount: null,
        category: '未分类', status: '进行中', note: '',
        missingReason: item.missingReason, createdAt: now, updatedAt: now
      };
      data.records.push(project);
      projectsAdded++;
    } else {
      const before = JSON.stringify([project.externalId, project.title, project.importedTitle, project.missingReason, project.note]);
      if (!project.titleEdited) project.title = item.title;
      project.externalId = item.externalId;
      project.importedTitle = item.title;
      project.missingReason = item.missingReason;
      if ([oldWorkspaceNote, '从 Codex 项目同步。'].includes(project.note)) project.note = '';
      if (before !== JSON.stringify([project.externalId, project.title, project.importedTitle, project.missingReason, project.note])) {
        project.updatedAt = now;
        projectsUpdated++;
      }
    }
    projectByCodexId.set(item.codexProjectId, project);
  }

  if (scan.projectCatalogAvailable) {
    for (const project of data.records) {
      if (project.userId !== userId || project.kind !== 'project' || project.source !== 'codex'
        || !project.externalId?.startsWith('codex-project:') || projectByCodexId.has(project.externalId.slice('codex-project:'.length))) continue;
      if (project.missingReason !== 'codex') {
        project.missingReason = 'codex';
        project.updatedAt = now;
        projectsUpdated++;
      }
    }
  }

  for (const item of records) {
    const project = item.codexProjectId ? projectByCodexId.get(item.codexProjectId) : null;
    const projectId = project && !project.hidden ? project.id : null;
    if (project && !project.hidden) {
      if (project.startedAt > item.startedAt) project.startedAt = item.startedAt;
      if (project.lastActiveAt < item.lastActiveAt) project.lastActiveAt = item.lastActiveAt;
    }
    const existing = data.records.find(record => record.userId === userId && record.source === 'codex' && record.externalId === item.externalId);
    if (existing) {
      const before = JSON.stringify([existing.title, existing.preview, existing.projectId, existing.lastActiveAt,
        existing.messageCount, existing.aiDurationMs, existing.completedTurns, existing.incompleteTurns, existing.tokenUsage, existing.turns]);
      if (existing.title === '未命名 Codex 会话' || (!existing.titleEdited && existing.importedTitle === existing.title)) existing.title = item.title;
      existing.importedTitle = item.title;
      existing.preview = item.preview;
      existing.kind = 'conversation';
      if (!existing.projectEdited) {
        if (projectId) existing.projectId = projectId;
        else if (isAutoWorkspaceProject(data.records.find(record => record.id === existing.projectId) || {}, userId)) existing.projectId = null;
      }
      existing.lastActiveAt = item.lastActiveAt;
      existing.messageCount = item.messageCount;
      existing.aiDurationMs = item.aiDurationMs;
      existing.completedTurns = item.completedTurns;
      existing.incompleteTurns = item.incompleteTurns;
      existing.tokenUsage = item.tokenUsage;
      existing.turns = item.turns;
      if (before !== JSON.stringify([existing.title, existing.preview, existing.projectId, existing.lastActiveAt,
        existing.messageCount, existing.aiDurationMs, existing.completedTurns, existing.incompleteTurns, existing.tokenUsage, existing.turns])) {
        existing.updatedAt = now;
        updated++;
      }
    } else {
      data.records.push({
        id: randomUUID(), userId, ...item, kind: 'conversation', projectId, taskId: null, importedTitle: item.title,
        category: '未分类', status: '待回顾', note: '', createdAt: now, updatedAt: now
      });
      added++;
    }
  }

  data.records = data.records.filter(project => {
    const orphan = isAutoWorkspaceProject(project, userId) && !project.titleEdited && project.note === oldWorkspaceNote
      && !data.records.some(child => child.userId === userId && child.projectId === project.id && !child.hidden);
    if (orphan) projectsRemoved++;
    return !orphan;
  });
  return { added, updated, projectsAdded, projectsUpdated, removed, projectsRemoved };
}
