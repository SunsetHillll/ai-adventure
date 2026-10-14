import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseCodexFile } from '../lib/codex.mjs';
import { normalizeReport, projectInput, sourceHash } from '../lib/analysis.mjs';
import { shortName } from '../lib/world-rules.mjs';
import { inferDomain, levelProgress, encounterResultBadge, efficiencyBadge } from '../lib/game-world.mjs';

test('连续指令不伪造新目标，保存最终回复短摘要供研判', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'usage-analysis-test-'));
  const file = path.join(dir, 'sample.jsonl');
  const rows = [
    ['2026-10-11T10:00:00Z', 'session_meta', { id:'thread-a' }],
    ['2026-10-11T10:00:01Z', 'response_item', { type:'message', role:'user', content:[{type:'input_text',text:'完成登录系统'}] }],
    ['2026-10-11T10:00:02Z', 'event_msg', { type:'task_started', turn_id:'turn-1' }],
    ['2026-10-11T10:00:03Z', 'response_item', { type:'message', role:'assistant', phase:'final_answer', content:[{type:'output_text',text:'登录接口已实现，尚未运行测试。'}] }],
    ['2026-10-11T10:00:04Z', 'event_msg', { type:'task_complete', turn_id:'turn-1', duration_ms:2000 }],
    ['2026-10-11T10:00:05Z', 'response_item', { type:'message', role:'user', content:[{type:'input_text',text:'继续'}] }],
    ['2026-10-11T10:00:06Z', 'event_msg', { type:'task_started', turn_id:'turn-2' }],
    ['2026-10-11T10:00:07Z', 'event_msg', { type:'task_complete', turn_id:'turn-2', duration_ms:1000 }]
  ].map(([timestamp,type,payload]) => ({timestamp,type,payload}));
  try {
    await writeFile(file, rows.map(row => JSON.stringify(row)).join('\n'));
    const record = await parseCodexFile(file);
    assert.equal(record.turns[0].result, '登录接口已实现，尚未运行测试。');
    assert.deepEqual(record.turns[1].targets, []);
  } finally { await rm(dir, { recursive:true, force:true }); }
});

test('研判只接受当前项目和对话的关联轮次', () => {
  const project = { id:'project-1', title:'AI 监工', kind:'project' };
  const conversation = { id:'conversation-1', projectId:'project-1', kind:'conversation', title:'登录开发', turns:[{ id:'turn-1', objective:'完成登录系统', result:'接口已实现', usage:{input_tokens:100,cached_input_tokens:80,output_tokens:20,total_tokens:120} }] };
  const input = projectInput(project, [project, conversation]);
  assert.deepEqual(input.taxonomyHints.tokenMixByTurn,[{id:'turn-1',input:100,cachedInput:80,output:20}]);
  const report = normalizeReport({
    kind:'project', summary:'接口已写，但缺少测试。', progress:61, conversations:[
      { id:'conversation-1', progress:60, milestones:[{title:'完成登录接口',status:'部分完成',progress:60,difficulty:'中',roi:'无法判断',turnIds:['turn-1','foreign-turn']}] },
      { id:'foreign-conversation', progress:100 }
    ]
  }, input);
  assert.deepEqual(report.conversations[0].milestones[0].turnIds, ['turn-1']);
  assert.equal(report.conversations.length, 1);
  assert.equal(report.conversations[0].milestones[0].roi, '无法判断');
  assert.notEqual(sourceHash(input), sourceHash({ ...input, conversations:[] }));
  assert.equal(sourceHash(input), sourceHash({ ...input, taxonomyHints:{ previousDomain:'另一种称呼' } }));
  assert.equal(encounterResultBadge('cleared'), '已攻克');
  assert.equal(efficiencyBadge('unknown'), '投入待比较');
});

test('能力世界只保留有来源的领域、技能和关卡元素', () => {
  const project = { id:'p', title:'网页游戏', kind:'project' };
  const conversation = { id:'c', projectId:'p', kind:'conversation', title:'游戏开发', turns:[{ id:'t', objective:'修复碰撞', result:'已修复' }] };
  const input = projectInput(project, [project, conversation]);
  const report = normalizeReport({
    kind:'project', summary:'已处理碰撞问题', domain:{ name:'游戏开发', evidence:'项目目标是网页游戏' },
    generalSkills:[{ id:'verification', level:'实践', evidence:'用户要求运行检查', conversationIds:['c','outside'] }, { id:'invented', level:'熟练', evidence:'无效', conversationIds:['c'] }],
    professionalSkills:[{ name:'游戏调试', level:'入门', evidence:'处理碰撞', conversationIds:['c'] }],
    conversations:[{ id:'c', game:{ levelTitle:'碰撞修复关', obstacle:{ title:'碰撞失灵', evidence:'首轮请求', turnIds:['t','other'] }, treasure:{ title:'可玩原型', evidence:'', turnIds:['t'] } } }]
  }, input);
  assert.equal(report.domain.name, '游戏开发');
  assert.deepEqual(report.generalSkills.map(item => item.id), ['verification']);
  assert.deepEqual(report.generalSkills[0].conversationIds, ['c']);
  assert.equal(report.professionalSkills[0].name, '游戏调试');
  assert.deepEqual(report.conversations[0].game.obstacle.turnIds, ['t']);
  assert.equal(report.conversations[0].game.treasure, null);
  assert.equal(shortName('根据你的要求，我已经把这个游戏做好了。'), '');
  assert.equal(shortName('碰撞失灵'), '碰撞失灵');
});

test('开发项目同步后先进入有证据的世界，已完成执行显示关卡已闯过', () => {
  assert.equal(inferDomain({ title:'F1小经理' }, [{ title:'开发赛车小游戏与赛道策略' }]).name, '游戏开发');
  assert.equal(inferDomain({ title:'AI监工' }, [{ title:'开发 AI 使用记录 agent' }]).name, '智能体开发');
  assert.equal(inferDomain({ title:'宠物' }, [{ title:'开发宠物小游戏' }]).name, '游戏开发');
  assert.equal(inferDomain({ title:'天机' }, [{ title:'这是我做的自媒体 IP 运营 agent，请审查已有功能' }]).name, '智能体开发');
  assert.equal(inferDomain({ title:'AI监工', analysis:{ domain:{ name:'待开发世界' } } }, [{ title:'开发AI使用记录agent' }]).name, '智能体开发');
  assert.equal(levelProgress({ turns:[{ completedAt:'2026-10-11T10:00:00Z' }] }), 'cleared');
  assert.equal(levelProgress({ turns:[{ completedAt:'2026-10-11T10:00:00Z' },{}] }), 'active');
});

test('逐次行动结算只能引用当前关卡轮次且必须有证据', () => {
  const project={ id:'p', title:'游戏开发', kind:'project' };
  const conversation={ id:'c', projectId:'p', kind:'conversation', title:'修复碰撞', turns:[{ id:'t', objective:'修复碰撞', result:'已修复' }] };
  const report=normalizeReport({ kind:'project', summary:'处理碰撞问题', conversations:[{ id:'c', game:{ encounters:[
    { turnId:'t', type:'battle', title:'碰撞失灵', gain:'可玩原型', result:'progress', efficiency:'unknown', evidence:'回复称修复了碰撞' },
    { turnId:'other', type:'treasure', title:'假宝藏', gain:'假产物', evidence:'不属于此关' },
    { turnId:'t', type:'treasure', title:'重复行动', gain:'重复奖励', evidence:'重复' }
  ] } }] },projectInput(project,[project,conversation]));
  assert.deepEqual(report.conversations[0].game.encounters.map(item=>item.title),['碰撞失灵']);
  assert.equal(report.conversations[0].game.encounters[0].efficiency,'unknown');
});
