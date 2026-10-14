export const COPYBOOK_VERSION = 2;

export const GENERAL_SKILLS = Object.freeze([
  { id: 'task-design', name: '任务设计', tool: '探路图', group: '规划' },
  { id: 'prompting', name: '提示词表达', tool: '指令号角', group: '表达' },
  { id: 'context', name: '上下文管理', tool: '记忆背包', group: '资料' },
  { id: 'tools', name: '工具使用', tool: '百变手套', group: '工具' },
  { id: 'steering', name: '过程控制', tool: '转向羽翼', group: '协作' },
  { id: 'verification', name: '结果验证', tool: '真相镜', group: '核验' },
  { id: 'reuse', name: '经验复用', tool: '秘卷', group: '复用' }
]);

export const GENERAL_SKILL_IDS = new Set(GENERAL_SKILLS.map(skill => skill.id));

const forbidden = /(?:本平台|本产品|作为一个|作为AI|我无法|根据你的要求|以下是|点击这里|项目称|对话称|包装成)/;

export function shortName(value, max = 12) {
  if (typeof value !== 'string') return '';
  const name = value.trim().replace(/[\s\r\n]+/g, ' ').replace(/[。！？!?，,；;：:]$/g, '');
  if (!name || name.length > max || forbidden.test(name) || /^(请|帮我|我想|我要|需要|请你)/.test(name)) return '';
  return name;
}

export function normalizeDomain(value) {
  if (!value || typeof value !== 'object') return null;
  const name = shortName(value.name, 20);
  const evidence = typeof value.evidence === 'string' ? value.evidence.trim().slice(0, 300) : '';
  if (!name || !evidence) return null;
  return { name, evidence };
}

export function normalizeGameItem(value, allowedTurns) {
  if (!value || typeof value !== 'object') return null;
  const title = shortName(value.title, 16);
  const evidence = typeof value.evidence === 'string' ? value.evidence.trim().slice(0, 300) : '';
  const turnIds = [...new Set((Array.isArray(value.turnIds) ? value.turnIds : []).filter(id => allowedTurns.has(id)))].slice(0, 12);
  if (!title || !evidence || !turnIds.length) return null;
  return { title, evidence, turnIds };
}
