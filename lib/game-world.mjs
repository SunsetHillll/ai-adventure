const rules = [
  { name: '游戏开发', pattern: /游戏|小游戏|game|f1|赛车|赛道|引擎|关卡|像素|宠物.*(?:demo|开发)|godot|unity|unreal/i, icon: '◈', tone: 'coral' },
  { name: '智能体开发', pattern: /agent|智能体|监工|codex|提示词工程|工作流|自动化|模型接入|ai应用/i, icon: '✦', tone: 'violet' },
  { name: '应用开发', pattern: /网页|网站|前端|后端|源码|软件|应用|程序|代码|接口|重建|部署|typescript|javascript/i, icon: '⬡', tone: 'blue' },
  { name: '内容运营', pattern: /自媒体|内容运营|ip运营|视频|写作|公众号|播客|社群/i, icon: '✿', tone: 'gold' },
  { name: '研究学习', pattern: /研究|学习|论文|课程|知识|调查/i, icon: '◇', tone: 'mint' }
];

export function canonicalDomain(value) {
  const source = String(value || '').trim();
  if (!source || /待开发|待发现|未知|未分类|待定|其他世界/.test(source)) return '';
  if (/游戏|game|赛车|像素|引擎/i.test(source)) return '游戏开发';
  if (/智能体|agent|ai应用|自动化|模型|ai.*开发/i.test(source)) return '智能体开发';
  if (/应用|软件|网页|网站|前端|后端|程序|代码/i.test(source)) return '应用开发';
  if (/内容|自媒体|运营|写作|视频/i.test(source)) return '内容运营';
  if (/研究|学习|教育/i.test(source)) return '研究学习';
  return source.slice(0, 20);
}

export function inferDomain(project, conversations = []) {
  const analyzed = canonicalDomain(project?.analysis?.domain?.name);
  if (analyzed) return { name: analyzed, basis: 'ai', original: project.analysis.domain.name };
  const title = String(project?.title || '');
  const details = [project?.note || '', ...conversations.slice(0, 5).flatMap(item => [item.title || '', item.preview || ''])].join(' ').slice(0, 3000);
  if (/游戏|小游戏|game|f1|赛车/i.test(title)) return { name:'游戏开发', basis:'inferred' };
  if (/agent|智能体/i.test(`${title} ${details}`) && /开发|功能|源码|项目|做的|搭建|构建|实现/i.test(`${title} ${details}`)) return { name:'智能体开发', basis:'inferred' };
  const scores = rules.map((rule, index) => {
    const titleHits = title.match(new RegExp(rule.pattern.source, rule.pattern.flags.includes('g') ? rule.pattern.flags : `${rule.pattern.flags}g`))?.length || 0;
    const detailHits = details.match(new RegExp(rule.pattern.source, rule.pattern.flags.includes('g') ? rule.pattern.flags : `${rule.pattern.flags}g`))?.length || 0;
    return { rule, score: titleHits * 5 + Math.min(detailHits, 5), index };
  }).sort((a, b) => b.score - a.score || a.index - b.index);
  if (scores[0]?.score) return { name: scores[0].rule.name, basis: 'inferred' };
  return { name: '自由探索', basis: 'unclassified' };
}

export function worldStyle(name) {
  return rules.find(rule => rule.name === name) || { icon: '✧', tone: 'mint' };
}

export function levelProgress(record) {
  const turns = Array.isArray(record?.turns) ? record.turns : [];
  if (!turns.length) return record?.status === '已完成' ? 'cleared' : 'new';
  const complete = turns.filter(turn => Boolean(turn.completedAt)).length;
  if (complete === turns.length) return 'cleared';
  return complete ? 'active' : 'new';
}

export function encounterBadge(encounter) {
  const type = encounter?.type;
  return type === 'treasure' ? '发现宝藏' : type === 'battle' ? '迎战难题' : type === 'discovery' ? '获得线索' : '继续冒险';
}

export function efficiencyBadge(value) {
  return ({ swift:'高效通关', steady:'稳步推进', costly:'消耗偏高', unknown:'投入待比较' })[value] || '投入待比较';
}

export function encounterResultBadge(value) {
  return ({ cleared:'已攻克', progress:'有推进', blocked:'仍受阻', unclear:'战果待核' })[value] || '战果待核';
}
