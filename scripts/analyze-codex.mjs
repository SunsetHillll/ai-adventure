import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JsonStore } from '../lib/store.mjs';
import { projectInput, weekInput, sourceHash, runAnalysis } from '../lib/analysis.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const store = new JsonStore(path.join(root, 'data', 'app.json'));
const state = await store.read();
if (state.users.length !== 1) throw new Error('本地账号不是唯一账号，无法选择研判账号');
const userId = state.users[0].id;
const records = state.records.filter(record => record.userId === userId && !record.hidden);
const mode = process.argv[2] || 'project';
const selector = process.argv[3];

async function saveProject(project) {
  const input = projectInput(project, records);
  if (!input.conversations.length) return console.log(`跳过空项目：${project.title}`);
  const report = await runAnalysis(input, { timeoutMs:180000 });
  report.generatedAt = new Date().toISOString();
  report.sourceHash = sourceHash(input);
  await store.update(data => {
    const current = data.records.find(record => record.id === project.id && record.userId === userId);
    if (!current) throw new Error('项目已不存在');
    current.analysis = report;
    current.analysisSourceHash = report.sourceHash;
  });
  console.log(`已保存项目研判：${project.title}，对话 ${report.conversations.length}，里程碑 ${report.conversations.reduce((sum, item) => sum + item.milestones.length, 0)}`);
}

if (mode === 'project') {
  const projects = records.filter(record => record.kind === 'project' && (!selector || record.id === selector || record.title === selector));
  if (!projects.length) throw new Error('没有匹配的项目');
  for (const project of projects) await saveProject(project);
} else if (mode === 'week') {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(selector || '')) throw new Error('周日期格式应为 YYYY-MM-DD');
  const start = new Date(`${selector}T00:00:00`);
  start.setDate(start.getDate() - ((start.getDay() + 6) % 7));
  const end = new Date(start); end.setDate(end.getDate() + 7);
  const input = weekInput(start.toISOString(), end.toISOString(), records);
  if (!input.conversations.length) throw new Error('该周没有可研判对话');
  const report = await runAnalysis(input, { timeoutMs:180000 });
  report.generatedAt = new Date().toISOString();
  report.sourceHash = sourceHash(input);
  await store.update(data => {
    data.reports ||= [];
    data.reports = data.reports.filter(item => !(item.userId === userId && item.kind === 'week' && item.start === report.start));
    data.reports.push({ ...report, userId });
  });
  console.log(`已保存周复盘：${selector}`);
} else throw new Error('用法：node scripts/analyze-codex.mjs project [项目名] 或 week YYYY-MM-DD');
