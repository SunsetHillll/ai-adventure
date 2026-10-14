import { inferDomain, worldStyle, levelProgress, encounterBadge, encounterResultBadge, efficiencyBadge } from '/game-world.mjs';

const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[char]);
const state = { user:null, records:[], reports:[], analysisStatus:null, view:'map', date:day(new Date()), selectedWorld:null, selectedProject:null, editing:null, pendingAnalysis:null };
const gear = [
  { id:'task-design', name:'任务设计', item:'探路图', icon:'⌁' },
  { id:'prompting', name:'提示词表达', item:'指令号角', icon:'✦' },
  { id:'context', name:'上下文管理', item:'记忆背包', icon:'▣' },
  { id:'tools', name:'工具使用', item:'百变手套', icon:'⚙' },
  { id:'steering', name:'过程控制', item:'转向羽翼', icon:'➤' },
  { id:'verification', name:'结果验证', item:'真相镜', icon:'◇' },
  { id:'reuse', name:'经验复用', item:'秘卷', icon:'✧' }
];

function day(date) { return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`; }
function dateLabel(value) { return new Date(`${value}T12:00:00`).toLocaleDateString('zh-CN', { year:'numeric', month:'long', day:'numeric', weekday:'short' }); }
function shortDate(value) { return value ? new Date(value).toLocaleDateString('zh-CN', { month:'numeric', day:'numeric' }) : ''; }
function clock(value) { return value ? new Date(value).toLocaleTimeString('zh-CN', { hour:'2-digit', minute:'2-digit' }) : ''; }
function duration(value) { if (value == null) return '未知'; const s=Math.round(value/1000); return s>=3600?`${Math.floor(s/3600)}h ${Math.floor(s%3600/60)}m`:s>=60?`${Math.floor(s/60)}m ${s%60}s`:`${s}s`; }
function tokens(value) { return value == null?'未知':new Intl.NumberFormat('zh-CN').format(value); }
function kind(record) { return record?.kind || 'conversation'; }
function projects() { return state.records.filter(record => kind(record)==='project'); }
function conversations() { return state.records.filter(record => kind(record)==='conversation'); }
function byId(id) { return state.records.find(record => record.id===id); }
function projectLevels(projectId) { return conversations().filter(record => record.projectId===projectId); }
function reportFor(record) { return record?.projectId ? byId(record.projectId)?.analysis?.conversations?.find(item => item.id===record.id) : null; }
function recordTurns(record) { return Array.isArray(record?.turns)?record.turns:[]; }
function turnsOn(record,date) { return recordTurns(record).filter(turn=>turn.startedAt&&day(new Date(turn.startedAt))===date); }
function turnsIn(record,start,end) { return recordTurns(record).filter(turn=>turn.startedAt&&new Date(turn.startedAt)>=start&&new Date(turn.startedAt)<end); }
function sumDuration(turns) { return turns.reduce((sum,turn)=>sum+(turn.durationMs||0),0); }
function sumTokens(turns) { return turns.reduce((sum,turn)=>sum+(turn.usage?.total_tokens||0),0); }
function sumCachedTokens(turns) { return turns.reduce((sum,turn)=>sum+(turn.usage?.cached_input_tokens||0),0); }
function missing(project) { return project?.missingReason==='codex'?'Codex 项目已移除':project?.missingReason==='directory'?'项目目录不可用':''; }

async function api(path, options={}) {
  const response=await fetch(path,{ credentials:'same-origin', headers:{ 'Content-Type':'application/json' }, ...options });
  let data; try { data=await response.json(); } catch { throw new Error('本地服务响应无法读取'); }
  if(!response.ok){
    const error=new Error(data.error||`请求失败（${response.status}）`);
    if(response.status===401&&!['/api/login','/api/setup'].includes(path)){
      error.sessionExpired=true;
      if(state.user){state.user=null;showAuth(false);$('#authError').textContent='登录状态已失效。已保存的战果仍在账号里，请重新进入。';}
    }
    throw error;
  }
  return data;
}
function notice(message,error=false) { const box=$('#notice'); box.textContent=message; box.classList.remove('hidden'); box.classList.toggle('error',error); }
function showAuth(setup) { $('#auth').classList.remove('hidden'); $('#app').classList.add('hidden'); $('#settlementOverlay').classList.add('hidden'); $('#authTitle').textContent=setup?'创建冒险者存档':'继续你的冒险'; $('#authHint').textContent=setup?'建立仅保存在本机的账号。':'进入你的能力世界。'; $('#authSubmit').textContent=setup?'创建存档并进入':'进入世界'; $('#authForm').dataset.mode=setup?'setup':'login'; $('#password').autocomplete=setup?'new-password':'current-password'; }
async function loadData() { const [data,status]=await Promise.all([api('/api/records'),api('/api/analysis/status')]); state.records=data.records; state.reports=data.reports||[]; state.analysisStatus=status; render(); }
async function enter(user) { state.user=user; if(settlement.interrupted){settlement.items=[];settlement.interrupted=false;$('#settlementDock').classList.add('hidden');} $('#accountName').textContent=`· ${user.username}`; $('#auth').classList.add('hidden'); $('#app').classList.remove('hidden'); $('#todayPicker').value=state.date; $('#weekPicker').value=state.date; await loadData(); switchView('map'); settlementResume(state.analysisStatus?.active); }
function switchView(view) { state.view=view; $$('.view').forEach(node=>node.classList.toggle('active',node.id===`view-${view}`)); $$('[data-view]').forEach(node=>node.classList.toggle('active',node.dataset.view===view)); $('#crumb').textContent=({map:'世界地图',today:'今日冒险',levels:'关卡图鉴',week:'本周战报'})[view]; window.scrollTo({top:0,behavior:'smooth'}); if(state.user)companionReact('wave','',1100); }

const companion={busy:false,reset:null,rest:null,tip:0};
const companionFaces={idle:'•ᴗ•',wave:'•◡•',sleep:'–ᴗ–',searching:'•o•',thinking:'•ᴗ•',cheer:'✦ᴗ✦',concern:'•︵•'};
function companionRest() {
  clearTimeout(companion.rest);
  if(!state.user||companion.busy)return;
  companion.rest=setTimeout(()=>{if(!companion.busy)companionReact('sleep','',0);},40000);
}
function companionReact(mood,message='',durationMs=4200) {
  clearTimeout(companion.reset);
  for(const button of $$('#companion, #mobileCompanion')){
    button.dataset.mood=mood;
    button.querySelector('.companion-expression').textContent=companionFaces[mood]||companionFaces.idle;
  }
  for(const bubble of $$('#companionBubble, #mobileCompanionBubble')){
    bubble.textContent=message;
    bubble.classList.toggle('visible',Boolean(message));
  }
  if(durationMs)companion.reset=setTimeout(()=>{if(!companion.busy)companionReact('idle','',0);},durationMs);
  if(mood!=='sleep')companionRest();
}
function companionTip() {
  if(companion.busy)return;
  const all=conversations(),cleared=all.filter(record=>levelProgress(record)==='cleared').length;
  const unopened=all.filter(record=>!reportFor(record)).length;
  const todayTurns=all.flatMap(record=>turnsOn(record,state.date));
  const tips={
    map:[all.length?`地图上有 ${all.length} 个关卡，${cleared} 个已闯过。`:'先接上 Codex，我陪你点亮第一座世界。',unopened?`还有 ${unopened} 个关卡的宝箱等待开启。`:'宝箱都已打开，去看看星匠的装备册吧。'],
    today:[todayTurns.length?`这一天留下了 ${todayTurns.length} 次 AI 行动。`:'这一天还没有 AI 行动，换个日期找找足迹吧。',todayTurns.length?`这一天的 AI 战斗时间是 ${duration(sumDuration(todayTurns))}。`:'同步 Codex 后，新的足迹会出现在这里。'],
    levels:[all.length?`关卡图鉴收录了 ${all.length} 关。`:'第一道关卡还在等你发现。',unopened?`挑一个未结算关卡，看看它留下什么宝藏。`:'打开一关，重温战斗和收获吧。'],
    week:[`本周战报会把闯过的关卡串成一条路。`,`看完本周收获，再选下一周想挑战的目标。`]
  };
  const pool=tips[state.view]||tips.map;
  companionReact('cheer',pool[companion.tip++%pool.length],5200);
}
function companionBusy(mood,message){companion.busy=true;companionReact(mood,message,0);}
function companionFinish(success,message){companion.busy=false;companionReact(success?'cheer':'concern',message,5200);}

const settlement={items:[],index:0,startedAt:0,finishedAt:0,phase:'preparing',running:false,finished:false,recovered:false,interrupted:false,ticker:null,errors:[]};
function settlementElapsed(){const seconds=Math.max(0,Math.floor(((settlement.finishedAt||Date.now())-settlement.startedAt)/1000));return `${Math.floor(seconds/60)}:${String(seconds%60).padStart(2,'0')}`;}
function settlementOpen(){if(!settlement.items.length)return;$('#settlementOverlay').classList.remove('hidden');$('#settlementDock').classList.add('hidden');settlementRender();}
function settlementHide(){ $('#settlementOverlay').classList.add('hidden');$('#settlementDock').classList.toggle('hidden',!settlement.items.length); }
function settlementRender(){
  if(!settlement.items.length)return;
  const done=settlement.items.filter(item=>item.status==='done').length,total=settlement.items.length;
  const current=settlement.items[settlement.index];
  const phases={preparing:'整理旅程资料',evaluating:'星匠研判中',archiving:'封存战果',completed:'结算完成',failed:'有战果未能归档'};
  $('#settlementTitle').textContent=settlement.interrupted?'旅程暂时中断':settlement.finished?(settlement.errors.length?'本次结算暂有阻碍':'战果已收入宝箱'):'星匠正在整理战果';
  $('#settlementMessage').textContent=settlement.interrupted?`成功归档 ${done} 条；其余 ${total-done} 条没有完成。重新登录后可继续开启。`:settlement.finished?(settlement.errors.length?`成功归档 ${done} 条；${total-done} 条未完成，可稍后重试。`:`${done} 条路线的收获已经回到地图。`):`第 ${settlement.index+1} / ${total} 条路线正在结算；已经归档的战果可以在地图上查看。`;
  $('#settlementCount').textContent=`${done} / ${total} 条路线已归档`;
  $('#settlementElapsed').textContent=`已等待 ${settlementElapsed()}`;
  $('#settlementRoute').innerHTML=settlement.items.map((item,index)=>`<div class="settlement-route-item ${item.status}" ${item.status==='active'?'aria-current="step"':''}><span class="route-gem">${item.status==='done'?'✓':item.status==='failed'?'!':item.status==='active'?'✦':index+1}</span><span class="route-label" title="${esc(item.title)}">${esc(item.title)}</span></div>`).join('');
  $('#settlementPhase').textContent=phases[settlement.finished?(settlement.errors.length?'failed':'completed'):settlement.phase]||phases.evaluating;
  $('#settlementCurrent').textContent=settlement.finished?(settlement.errors.length?settlement.errors[0]:'所有战果已保存'):current?.title||'即将出发';
  const phaseIndex=settlement.finished?(settlement.errors.length?-1:3):({preparing:0,evaluating:1,archiving:2})[settlement.phase]??1;
  $('#settlementSteps').innerHTML=['整理线索','星匠研判','收纳战果'].map((label,index)=>`<div class="settlement-step ${phaseIndex>index?'done':phaseIndex===index?'active':''}"><i>${phaseIndex>index?'✓':index+1}</i><span>${label}</span></div>`).join('');
  $('#settlementFootnote').textContent=settlement.finished?(settlement.errors.length?'已成功归档的路线不会重复结算；未完成的路线可以重新开启。':'每一份战果都已保存，去看看新点亮的关卡和装备吧。'):'模型研判耗时随关卡数量和记录长度变化；完成一条路线，就会立即保存一份战果。';
  $('#settlementDone').classList.toggle('hidden',!settlement.finished);
  $('#settlementDockText').textContent=settlement.finished?`结算完成 · ${done}/${total}`:`结算中 · ${done}/${total}`;
}
function settlementBegin(previews,{recovered=false,startedAt=Date.now()}={}){
  clearInterval(settlement.ticker);
  settlement.items=previews.map(({input,preview})=>({title:preview?.input?.project?.title||preview?.title||'本周战报',kind:input.kind,status:'queued'}));
  settlement.index=0;settlement.startedAt=startedAt;settlement.finishedAt=0;settlement.phase='preparing';settlement.running=true;settlement.finished=false;settlement.recovered=recovered;settlement.interrupted=false;settlement.errors=[];
  settlement.items[0].status='active';settlement.ticker=setInterval(settlementRender,1000);settlementOpen();
}
function settlementEnd(finishedAt=Date.now()){settlement.running=false;settlement.finished=true;settlement.finishedAt=finishedAt;settlement.recovered=false;clearInterval(settlement.ticker);settlementRender();}
function settlementResume(active){
  if(!active||settlement.running)return;
  settlementBegin([{input:{kind:active.kind},preview:{title:active.title}}],{recovered:true,startedAt:Date.parse(active.startedAt)||Date.now()});
  settlement.phase=active.phase||'evaluating';settlementRender();companionBusy('thinking','上一份战果还在整理中…');
}

function fallbackTitle(record,index=0) {
  const source=`${record?.title||''} ${record?.preview||''}`;
  const patterns=[
    [/白色小狗|小狗测试图片/,'小狗造型试炼'],[/毛茸茸|美术素材|图片素材/,'美术寻宝'],[/赛道|比赛|保胎|进站/,'赛道策略试炼'],[/宠物.*游戏|游戏.*宠物/,'宠物世界开局'],
    [/自媒体|IP运营/i,'内容智囊试炼'],[/使用记录|AI监工/i,'能力世界开局'],[/源码|逆向|重建/,'源码重建试炼'],[/全量阅读|读取文件|阅读文件/,'探索项目地图'],[/修复|报错|故障/,'故障挑战'],[/网页|前端/,'网页创作试炼']
  ];
  for(const [pattern,title] of patterns) if(pattern.test(source)) return title;
  const simple=String(record?.title||'').replace(/^\s*(?:\d+[，,.、)]\s*)?(?:请|帮我|我想|我要|需要|现在)\s*/,'').split(/[。！？!?,，；;\n]/)[0].trim();
  return simple.length>=2&&simple.length<=15?simple:`探索第 ${String(index+1).padStart(2,'0')} 关`;
}
function titleOf(record,index=0) { return reportFor(record)?.game?.levelTitle||fallbackTitle(record,index); }
function levelLabel(record) { return ({cleared:'已闯过',active:'冒险中',new:'待探索'})[levelProgress(record)]; }
function domainOf(project) { return inferDomain(project,projectLevels(project.id)); }
function worldGroups() { const groups=new Map(); projects().forEach(project=>{const domain=domainOf(project);if(!groups.has(domain.name))groups.set(domain.name,{name:domain.name,projects:[],basis:domain.basis});groups.get(domain.name).projects.push(project);});return [...groups.values()]; }
function metric(label,value,hint) { return `<div class="metric"><label>${esc(label)}</label><strong>${esc(value)}</strong><small>${esc(hint)}</small></div>`; }
function listItem(title,detail,button='') { return `<div class="week-list-item"><span class="bullet">✦</span><div><strong>${esc(title)}</strong>${detail?`<p>${esc(detail)}</p>`:''}</div>${button}</div>`; }

function renderMap() {
  const groups=worldGroups(),unassigned=conversations().filter(record=>!record.projectId||!byId(record.projectId));
  const worlds=[{name:'启程岛',island:true,projects:[],icon:'✧',tone:'island'},...groups.map(group=>({...group,...worldStyle(group.name)}))];
  if(unassigned.length)worlds.push({name:'自由海域',projects:[],icon:'☀',tone:'gold',free:true});
  $('#view-map .overline').innerHTML='WORLD SELECT · 你的冒险正在展开'+(state.records.some(record=>record.demo)?'<span class="demo-tag">模拟演示</span>':'');
  $('#worldCount').textContent=`${worlds.length} 个世界`;
  $('#worldCards').innerHTML=worlds.map(world=>{
    const count=world.island?`${gear.length} 件核心装备`:world.free?`${unassigned.length} 个自由关卡`:`${world.projects.length} 条路线 · ${world.projects.reduce((sum,p)=>sum+projectLevels(p.id).length,0)} 个关卡`;
    const copy=world.island?'星匠在这里收藏七件装备，每一次冒险都可能点亮一件。':world.free?'没有固定路线的挑战，也有属于自己的星光。':world.basis==='ai'?'这里的挑战与技能已经写进世界图鉴。':'沿着现有路线，寻找这片世界的宝藏与新技能。';
    return `<button class="world-card ${esc(world.tone)}" data-world="${esc(world.name)}"><span class="world-card-arrow">↗</span><span class="world-card-icon">${esc(world.icon)}</span><strong>${esc(world.name)}</strong><p>${esc(copy)}</p><small>${esc(count)}</small></button>`;
  }).join('');
  const all=conversations(),cleared=all.filter(record=>levelProgress(record)==='cleared').length,analyzed=all.filter(record=>reportFor(record)).length,allTurns=all.flatMap(recordTurns);
  $('#mapStatus').innerHTML=`<div class="map-status-stat"><span>已闯过关卡</span><strong>${cleared} / ${all.length}</strong></div><div class="map-status-stat"><span>已开启宝箱</span><strong>${analyzed} 关</strong></div><div class="map-status-stat"><span>AI 战斗时间</span><strong>${duration(sumDuration(allTurns))}</strong></div><div class="map-status-stat"><span>专业世界</span><strong>${groups.length} 个</strong></div><p class="map-status-note">还有 ${Math.max(0,all.length-analyzed)} 个关卡的收获没有揭晓。</p><button class="game-button gold" data-settle-all type="button">开启剩余宝箱</button>`;
  $('#mapSettleHint').textContent=analyzed?`${analyzed} 关宝箱已开启`:`${all.length-analyzed} 关宝箱等待开启`;
  $('#railHint').textContent=all.length?`已发现 ${all.length} 个关卡，其中 ${cleared} 个完成 AI 执行。`:'先接上 Codex，新的关卡就会落到地图上。';
  renderSkillAtlas();if(state.selectedWorld)showWorld(state.selectedWorld,false);
}
function renderSkillAtlas() {
  const levels={'证据不足':0,'接触':1,'入门':2,'实践':3,'熟练':4},found=new Map();
  projects().forEach(project=>(project.analysis?.generalSkills||[]).forEach(item=>{const old=found.get(item.id);if(!old||levels[item.level]>levels[old.level])found.set(item.id,{...item,project:project.title});}));
  $('#skillAtlas').innerHTML=gear.map(item=>{const entry=found.get(item.id);return `<div class="gear-card ${entry?'':'locked'}"><span class="gear-icon">${item.icon}</span><strong>${esc(item.item)}</strong><span>${esc(item.name)} · ${esc(entry?.level||'尚未点亮')}</span><p>${esc(entry?`${entry.evidence} · ${entry.project}`:'等待真实关卡留下证据')}</p></div>`;}).join('');
}
function showWorld(name,scroll=true) {
  state.selectedWorld=name;const panel=$('#worldDetail');
  if(name==='启程岛')panel.innerHTML=`<span class="overline">STARTER ISLAND</span><h2>星匠的装备册</h2><p>这里收藏你在不同世界反复用到的协作本领。</p><button class="text-action" data-open-atlas>查看七件装备 ↗</button>`;
  else {const group=worldGroups().find(item=>item.name===name);const routes=name==='自由海域'?conversations().filter(item=>!item.projectId||!byId(item.projectId)).map(item=>({title:titleOf(item),detail:`${levelLabel(item)} · ${shortDate(item.startedAt)}`,id:item.id,free:true})):(group?.projects||[]).map(project=>({title:project.title,detail:`${projectLevels(project.id).length} 个关卡 · ${missing(project)||'继续冒险'}`,id:project.id}));panel.innerHTML=`<span class="overline">WORLD MAP</span><h2>${esc(name)}</h2><p>选择路线，看看已经闯过哪些关卡。</p><div class="world-route-list">${routes.map((route,index)=>`<div class="world-route"><span class="route-orb">${index+1}</span><div><strong>${esc(route.title)}</strong><span>${esc(route.detail)}</span></div><button class="text-action" ${route.free?`data-level="${esc(route.id)}"`:`data-project="${esc(route.id)}"`}>进入 ↗</button></div>`).join('')||'<p class="empty-state">这片海域还没有关卡。</p>'}</div>`;}
  panel.classList.remove('hidden');if(scroll)panel.scrollIntoView({behavior:'smooth',block:'start'});
}

function renderToday() {
  const rows=conversations().map(record=>({record,turns:turnsOn(record,state.date)})).filter(item=>item.turns.length);
  const manual=state.records.filter(record=>record.source==='manual'&&kind(record)!=='project'&&day(new Date(record.startedAt))===state.date);
  const turns=rows.flatMap(item=>item.turns),cleared=rows.filter(item=>levelProgress(item.record)==='cleared').length;
  $('#todayTitle').textContent=`${dateLabel(state.date)}的冒险`;
  $('#todaySubtitle').textContent=rows.length?`今天在 ${new Set(rows.map(item=>item.record.projectId).filter(Boolean)).size} 条项目路线上留下足迹。`:'选择其他日期，或接入 Codex 开始新的冒险。';
  $('#todayHero').innerHTML=`<span class="overline" style="color:#bdeaf0">TODAY'S QUEST</span><h2>${rows.length?`今天推进 ${rows.length} 个关卡，完成 ${turns.filter(turn=>turn.completedAt).length} 次 AI 行动。`:'今天的地图还没有新足迹。'}</h2><p>${rows.length?`${cleared} 个关卡已闯过；打开关卡看看留下了什么。`:'新的挑战会在同步后出现。'}</p>`;
  $('#todayMetrics').innerHTML=metric('活跃关卡',rows.length,'有 Codex 行动')+metric('AI 行动',turns.filter(turn=>turn.completedAt).length,`${turns.length} 次记录`)+metric('AI 工作时间',duration(sumDuration(turns)),'模型与工具运行')+metric('Token 消耗',tokens(sumTokens(turns)),'本机日志计数');
  $('#todayTrail').innerHTML=rows.length?rows.sort((a,b)=>new Date(a.turns[0].startedAt)-new Date(b.turns[0].startedAt)).map(({record,turns})=>{const project=byId(record.projectId);return `<div class="trail-card"><span class="trail-time">${esc(clock(turns[0].startedAt))}</span><div><strong>${esc(titleOf(record))}</strong><small>${esc(project?.title||'自由海域')} · ${turns.length} 次 AI 行动 · ${levelLabel(record)}</small></div><button data-level="${esc(record.id)}">查看结算 ↗</button></div>`;}).join(''):'<p class="empty-state">这一天还没有关卡足迹。</p>';
  const gains=[];rows.forEach(({record,turns})=>{const game=reportFor(record)?.game,ids=new Set(turns.map(turn=>turn.id));(game?.encounters||[]).filter(item=>ids.has(item.turnId)&&item.gain).forEach(item=>gains.push({title:item.gain,detail:`${titleOf(record)} · ${efficiencyBadge(item.efficiency)}`}));});
  $('#todayRewards').innerHTML=gains.length?gains.slice(0,6).map(item=>`<div class="reward-line"><strong>✦ ${esc(item.title)}</strong><p>${esc(item.detail)}</p></div>`).join(''):rows.length?'<p class="empty-state">今天的宝箱尚未开启。进入关卡结算，看看带回了什么。</p>':'<p class="empty-state">今天还没有可展示的收获。</p>';
  const active=rows.find(item=>levelProgress(item.record)!=='cleared')?.record,unjudged=rows.find(item=>!reportFor(item.record))?.record,next=active||unjudged;
  $('#todayNext').innerHTML=next?`<div class="next-line"><strong>${active?'继续挑战':'揭晓战果'} · ${esc(titleOf(next))}</strong><p>${active?'还有 AI 行动没有完成。':'这关已走完，等待 AI 提炼收获与投入效益。'}</p><button class="text-action" ${active?`data-level="${esc(next.id)}"`:`data-settle-project="${esc(next.projectId)}"`}>${active?'查看关卡':'自动结算'} ↗</button></div>`:manual.length?`<p class="empty-state">${manual.length} 条手动旅程已记下；连接 Codex 后可看逐次行动。</p>`:'<p class="empty-state">保持探索，新的路会在这里展开。</p>';
}

function renderLevels() {
  const list=projects(),free=conversations().filter(item=>!item.projectId||!byId(item.projectId));
  if(!state.selectedProject||(!list.some(item=>item.id===state.selectedProject)&&state.selectedProject!=='free'))state.selectedProject=list.find(item=>projectLevels(item.id).length)?.id||list[0]?.id||(free.length?'free':null);
  $('#levelTotal').textContent=`${conversations().length} 个关卡`;
  $('#projectRail').innerHTML=list.map(project=>`<button class="${state.selectedProject===project.id?'active':''}" data-project="${esc(project.id)}">${esc(project.title)}<small>${projectLevels(project.id).length} 个关卡 · ${esc(domainOf(project).name)}</small></button>`).join('')+(free.length?`<button class="${state.selectedProject==='free'?'active':''}" data-project="free">自由海域<small>${free.length} 个关卡</small></button>`:'');
  const current=byId(state.selectedProject),levels=state.selectedProject==='free'?free:projectLevels(state.selectedProject),world=current?domainOf(current).name:'自由海域',finished=levels.filter(record=>levelProgress(record)==='cleared').length;
  $('#archiveHeader').innerHTML=current?`<span class="overline" style="color:#bce7ec">${esc(world)} · PROJECT PATH</span><h2>${esc(current.title)}</h2><p>${levels.length} 个关卡 · ${finished} 个已闯过${missing(current)?` · ${esc(missing(current))}`:''}</p>${levels.length?`<button class="game-button gold" data-settle-project="${esc(current.id)}" type="button">${current.analysis&&!current.analysisStale?'重新结算这条路线':'✦ 自动结算战果'}</button>`:''}`:`<span class="overline" style="color:#bce7ec">SIDE QUESTS</span><h2>自由海域</h2><p>${levels.length} 个没有归属项目的关卡。</p>`;
  $('#levelGrid').innerHTML=levels.length?levels.map((record,index)=>{const status=levelProgress(record),turns=recordTurns(record),gain=reportFor(record)?.game?.treasure?.title;return `<button class="level-card ${status}" data-level="${esc(record.id)}"><span class="stage-number">STAGE ${String(index+1).padStart(2,'0')}</span><span class="level-status ${status}">${levelLabel(record)}</span><h3>${esc(titleOf(record,index))}</h3><p>${esc(gain?`宝藏 · ${gain}`:reportFor(record)?'宝箱已开启，查看这关收获':status==='cleared'?'挑战结束 · 奖励待开启':'挑战仍在继续')}</p><div class="level-card-foot"><span>${turns.length} 次 AI 行动</span><span>查看关卡 ↗</span></div></button>`;}).join(''):'<p class="empty-state">这条路线还没有关卡。</p>';
}

function guessAction(turn) {
  const value=String(turn?.objective||'').toLowerCase();
  if(/修复|错误|报错|故障|bug/.test(value))return {type:'battle',title:'迎战故障'};
  if(/生成|图片|美术|素材|设计/.test(value))return {type:'treasure',title:'寻找新素材'};
  if(/阅读|读取|评估|分析|审查/.test(value))return {type:'discovery',title:'侦察现状'};
  if(/开发|实现|增加|接入|优化|重构/.test(value))return {type:'battle',title:'打造新能力'};
  if(/继续|好的|ok|完成/.test(value))return {type:'journey',title:'推进当前挑战'};
  return {type:'journey',title:'探索新挑战'};
}
function levelDetail(record) {
  const report=reportFor(record),game=report?.game||{},turns=recordTurns(record),project=byId(record.projectId),status=levelProgress(record),linked=project?.analysis;
  const skills=[...(linked?.generalSkills||[]).filter(item=>item.conversationIds?.includes(record.id)).map(item=>gear.find(g=>g.id===item.id)?.name).filter(Boolean),...(linked?.professionalSkills||[]).filter(item=>item.conversationIds?.includes(record.id)).map(item=>item.name)];
  const chips=[game.obstacle?.title?`<span class="loot-chip monster">难题 · ${esc(game.obstacle.title)}</span>`:'',game.treasure?.title?`<span class="loot-chip">宝藏 · ${esc(game.treasure.title)}</span>`:'',...skills.map(item=>`<span class="loot-chip skill">能力 · ${esc(item)}</span>`)].filter(Boolean).join('');
  const encounters=turns.map((turn,index)=>{
    const found=(game.encounters||[]).find(item=>item.turnId===turn.id),fallback=guessAction(turn),type=found?.type||fallback.type;
    const result=found?encounterResultBadge(found.result):turn.completedAt?'战果待结算':'执行中';
    const cached=turn.usage?.cached_input_tokens||0;
    return `<div class="encounter-card"><div class="encounter-top"><span class="encounter-type">${String(index+1).padStart(2,'0')} · ${encounterBadge({type})}</span><strong>${esc(found?.title||fallback.title)}</strong><span class="encounter-result ${esc(found?.result||'unclear')}">战果 · ${result}</span>${found?`<span class="efficiency ${esc(found.efficiency||'unknown')}">投入 · ${efficiencyBadge(found.efficiency)}</span>`:''}</div><p>${esc(found?.gain?`获得 · ${found.gain}`:found?.result==='blocked'?'难题尚未攻克':turn.completedAt?'AI 已行动 · 战果等待结算':'AI 行动尚未完成')}</p>${found?.efficiencyReason?`<p>${esc(found.efficiencyReason)}</p>`:''}<small>AI 工作 ${turn.durationMs==null?'未知':duration(turn.durationMs)} · 总计 ${tokens(turn.usage?.total_tokens)} token${cached?`（缓存输入 ${tokens(cached)}）`:''}${found?.evidence?` · 依据：${esc(found.evidence)}`:''}</small></div>`;
  }).join('');
  const cachedTotal=sumCachedTokens(turns);
  return `<div class="level-summary"><span class="level-status ${status}">${levelLabel(record)}</span><h3>${esc(titleOf(record))}</h3><p>${esc(project?.title||'自由海域')} · ${turns.length} 次 AI 行动 · ${esc(shortDate(record.startedAt))}</p><div class="level-summary-metrics"><span>AI 工作 ${duration(sumDuration(turns))}</span><span>总计 ${tokens(sumTokens(turns))} token${cachedTotal?` · 缓存输入 ${tokens(cachedTotal)}`:''}</span><span>${report?`通关进度 ${report.progress==null?'待判断':`${report.progress}% · AI 推断`}`:'宝箱待开启'}</span></div>${chips}</div><div class="level-detail-body">${report?`<h3>关卡结算</h3><p>${esc(report.summary||report.progressReason||'战果已经写入图鉴。')}</p>`:`<h3>行动足迹已保存</h3><p>这关的宝箱还没有开启。让星匠整理战果，看看获得了什么。</p>${record.projectId?`<button class="game-button gold" data-settle-project="${esc(record.projectId)}" type="button">✦ 开启这条路线的宝箱</button>`:''}`}<h3>行动足迹</h3><div class="encounter-list">${encounters||'<p class="empty-state">暂无逐次 AI 行动。</p>'}</div><details class="raw-log"><summary>查看原始旅程记录</summary><div class="raw-entry"><strong>原始对话名称</strong><p>${esc(record.title)}</p></div>${turns.map((turn,index)=>`<div class="raw-entry"><strong>${String(index+1).padStart(2,'0')} · ${esc(shortDate(turn.startedAt))} ${esc(clock(turn.startedAt))}</strong><p>${esc(turn.objective||'本次请求无可用文字')}</p>${turn.result?`<p>AI 回复摘要：${esc(turn.result)}</p>`:''}</div>`).join('')}</details><button class="text-action" data-edit="${esc(record.id)}">修订关卡资料 ↗</button></div>`;
}
function openLevel(id) {
  const record=byId(id);if(!record)return;
  $('#levelDialogTitle').textContent=titleOf(record);$('#levelDetail').innerHTML=levelDetail(record);
  const milestones=reportFor(record)?.milestones||[];
  if(milestones.length){
    const checkpointHtml=`<section class="checkpoint-section"><h3>通关检查点</h3><div class="checkpoint-list">${milestones.map((item,index)=>{
      const rank=({划算:'高效通关',一般:'稳步推进',不划算:'消耗偏高',无法判断:'投入待比较'})[item.roi]||'投入待比较';
      const result=({已完成:'已攻克',部分完成:'推进中',未完成:'尚未攻克',证据不足:'战果未明'})[item.status]||'战果未明';
      return `<div class="checkpoint-card"><span>CHECKPOINT ${String(index+1).padStart(2,'0')} · ${esc(result)}</span><strong>${esc(item.title)}</strong><p>${esc(item.reason||'还没有足够线索判断这一目标。')}</p><small>${esc(rank)}${item.roiReason?` · ${esc(item.roiReason)}`:''}${item.manualAlternative?` · 亲手闯关时机：${esc(item.manualAlternative)}`:''}</small></div>`;
    }).join('')}</div></section>`;
    $('#levelDetail .raw-log')?.insertAdjacentHTML('beforebegin',checkpointHtml);
  }
  $('#levelOverlay').classList.remove('hidden');
}

function weekBounds(date) { const start=new Date(`${date}T00:00:00`);start.setDate(start.getDate()-((start.getDay()+6)%7));const end=new Date(start);end.setDate(end.getDate()+7);return {start,end}; }
function renderWeek() {
  const {start,end}=weekBounds(state.date),rows=conversations().map(record=>({record,turns:turnsIn(record,start,end)})).filter(item=>item.turns.length),turns=rows.flatMap(item=>item.turns),completed=turns.filter(turn=>turn.completedAt).length;
  const weekReport=state.reports.find(item=>item.kind==='week'&&item.start===start.toISOString()),last=new Date(end);last.setDate(last.getDate()-1);
  $('#weekRange').textContent=`${shortDate(start)} — ${shortDate(last)} · 这一周的关卡、成长和下周方向`;
  $('#settleWeek').disabled=!turns.length;
  $('#settleWeek').textContent=turns.length?weekReport?.stale?'✦ 更新本周结算':weekReport?'✦ 重看本周结算':'✦ 生成本周结算':'暂无可结算的行动';
  const worlds=new Set(rows.map(item=>byId(item.record.projectId)).filter(Boolean).map(project=>domainOf(project).name));
  $('#weekHero').innerHTML=`<span class="overline" style="color:#bdeaf0">WEEKLY QUEST LOG</span><h2>${rows.length?`这一周在 ${worlds.size} 个世界，推进了 ${rows.length} 个关卡。`:'这一周还没有新的冒险足迹。'}</h2><p>${esc(weekReport?.summary||'本周宝箱尚未开启；点击结算，看看留下了什么。')}</p>`;
  $('#weekMetrics').innerHTML=metric('活跃关卡',rows.length,'涉及的对话')+metric('AI 行动',completed,`${turns.length} 次记录`)+metric('AI 工作时间',duration(sumDuration(turns)),'模型与工具运行')+metric('Token 消耗',tokens(sumTokens(turns)),'本机日志计数');
  $('#weekLevels').innerHTML=rows.length?rows.slice(0,8).map(({record,turns})=>listItem(titleOf(record),`${byId(record.projectId)?.title||'自由海域'} · ${turns.length} 次行动 · ${levelLabel(record)}`,`<button class="text-action" data-level="${esc(record.id)}">查看 ↗</button>`)).join(''):'<p class="empty-state">本周没有关卡足迹。</p>';
  const growth=weekReport?.skillChanges||[],linkedIds=new Set(rows.map(item=>item.record.id));
  const projectGrowth=projects().flatMap(project=>[...(project.analysis?.generalSkills||[]).filter(item=>item.conversationIds?.some(id=>linkedIds.has(id))).map(item=>({name:gear.find(g=>g.id===item.id)?.name||item.id,evidence:item.evidence})),...(project.analysis?.professionalSkills||[]).filter(item=>item.conversationIds?.some(id=>linkedIds.has(id))).map(item=>({name:item.name,evidence:item.evidence}))]);
  const growthRows=growth.length?growth.map(item=>({name:item.name,evidence:item.evidence})):projectGrowth;
  $('#weekGrowth').innerHTML=growthRows.length?growthRows.slice(0,6).map(item=>listItem(item.name,item.evidence)).join(''):rows.length?'<p class="empty-state">这周的能力星光还没归档。开启战报，看看哪件装备变强了。</p>':'<p class="empty-state">这周还没有能力证据。</p>';
  const challenges=weekReport?.gaps?.length?weekReport.gaps.map(item=>({name:item})):rows.filter(item=>levelProgress(item.record)!=='cleared').map(item=>({name:`${titleOf(item.record)} · 仍在冒险中`}));
  $('#weekChallenges').innerHTML=challenges.length?challenges.slice(0,5).map(item=>listItem(item.name,'')).join(''):'<p class="empty-state">可见记录中没有尚未完成的 AI 行动；实际成果仍可在关卡结算里查看。</p>';
  const suggestions=weekReport?.nextWeek?.length?weekReport.nextWeek:weekReport?.recommendations?.length?weekReport.recommendations:challenges.length?['优先完成仍在进行的关卡，再检查得到的产物是否可用。']:rows.length?['为本周关卡生成结算，找出可复用的技能和下次可改进的步骤。']:['接入 Codex 或补充旅程，留下下一次冒险的起点。'];
  $('#weekNext').innerHTML=suggestions.slice(0,5).map(item=>listItem(item,'')).join('');
}
function render() { if(!state.user)return;renderMap();renderToday();renderLevels();renderWeek(); }

function fillTasks(selected='') { const projectId=$('#recordProject').value,tasks=state.records.filter(item=>kind(item)==='task'&&(!projectId||item.projectId===projectId));$('#recordTask').innerHTML='<option value="">无支线</option>'+tasks.map(item=>`<option value="${esc(item.id)}">${esc(item.title)}</option>`).join('');$('#recordTask').value=selected; }
function openEditor(record=null) {
  state.editing=record;$('#editorTitle').textContent=record?'修订旅程资料':'补充旅程';$('#recordKind').value=kind(record)||'conversation';$('#recordKind').disabled=Boolean(record);$('#recordTitle').value=record?.title||'';$('#recordCategory').value=record?.category||'未分类';$('#recordStatus').value=record?.status||'进行中';$('#recordNote').value=record?.note||'';$('#recordDate').value=day(record?.startedAt?new Date(record.startedAt):new Date());$('#recordTime').value=(record?.startedAt?new Date(record.startedAt):new Date()).toTimeString().slice(0,5);$('#recordDuration').value=record?.durationMinutes||'';
  $('#recordProject').innerHTML='<option value="">自由海域</option>'+projects().filter(item=>item.id!==record?.id).map(item=>`<option value="${esc(item.id)}">${esc(item.title)}</option>`).join('');$('#recordProject').value=record?.projectId||'';fillTasks(record?.taskId||'');$('#deleteRecord').classList.toggle('hidden',!record);$('#manualFields').classList.toggle('hidden',record?.source==='codex');$('#statusField').classList.toggle('hidden',record?.source==='codex');$('#durationField').classList.toggle('hidden',kind(record)==='project');$('#editorOverlay').classList.remove('hidden');
}
function closeOverlay(id) { $(`#${id}`).classList.add('hidden');if(id==='analysisOverlay'){state.pendingAnalysis=null;$('#analysisConsent').checked=false;$('#confirmAnalysis').disabled=true;}if(id==='editorOverlay')state.editing=null; }

async function prepareAnalysis(kind,projectId=null,button=null) {
  if(settlement.running||state.analysisStatus?.active){settlementResume(state.analysisStatus?.active);settlementOpen();return;}
  if(button)button.disabled=true;
  try {
    const selected=kind==='week'?[{kind:'week',date:state.date}]:kind==='all'?projects().filter(project=>projectLevels(project.id).length&&(!project.analysis||project.analysisStale)).map(project=>({kind:'project',projectId:project.id})):[{kind:'project',projectId}];
    if(!selected.length){notice('所有项目路线都已结算。');return;}
    const previews=await Promise.all(selected.map(async input=>({input,preview:await api(`/api/analysis/preview?${new URLSearchParams(input)}`)})));
    const count=previews.reduce((sum,item)=>sum+item.preview.input.conversations.length,0),turns=previews.reduce((sum,item)=>sum+item.preview.input.conversations.reduce((n,record)=>n+record.turns.length,0),0);
    $('#analysisTitle').textContent=kind==='week'?'生成本周结算':kind==='all'?'结算全部待解锁关卡':'结算项目路线';
    $('#analysisScope').textContent=`本次将发起 ${previews.length} 次模型结算，覆盖 ${count} 个关卡、${turns} 次 AI 行动。AI 会自动判断成果、能力与投入效益，无需逐条填写。`;
    $('#analysisPreview').textContent=JSON.stringify(previews.map(item=>item.preview.input),null,2);
    state.pendingAnalysis={previews};$('#analysisConsent').checked=false;$('#confirmAnalysis').disabled=true;$('#analysisOverlay').classList.remove('hidden');
  } catch(error){notice(error.message,true);}finally{if(button)button.disabled=false;}
}
async function runAnalysis(previews) {
  settlementBegin(previews);
  companionBusy('thinking','正在打开宝箱，整理这一路的收获…');
  for(let i=0;i<previews.length;i++){
    const {input,preview}=previews[i],item=settlement.items[i];
    settlement.index=i;settlement.phase='preparing';item.status='active';state.analysisStatus={...state.analysisStatus,active:null};settlementRender();
    notice(`AI 正在结算 ${i+1} / ${previews.length} · ${item.title}`);
    companionBusy('thinking',`正在结算第 ${i+1} / ${previews.length} 份战果…`);
    try{
      await api('/api/analysis',{method:'POST',body:JSON.stringify({...input,consent:true,sourceHash:preview.sourceHash})});
      item.status='done';settlement.phase='archiving';settlementRender();
      try{await loadData();}catch(error){if(error.sessionExpired){settlement.interrupted=true;break;}notice('战果已保存，页面资料暂时未刷新；重新进入地图即可查看。',true);}
    }catch(error){
      item.status='failed';settlement.errors.push(`${item.title}：${error.message}`);
      if(error.sessionExpired){settlement.interrupted=true;break;}
    }
    settlementRender();
  }
  settlementEnd();
  if(settlement.interrupted)return;
  notice(settlement.errors.length?`已完成部分结算；${settlement.errors.join('；')}`:`${previews.length} 份结算已完成，战果已加入地图。`,Boolean(settlement.errors.length));
  companionFinish(!settlement.errors.length,settlement.errors.length?'有些宝箱暂时打不开，看看上方提示吧。':'宝箱打开啦！去地图上看看新收获。');
}

$('#authForm').addEventListener('submit',async event=>{event.preventDefault();const button=$('#authSubmit');button.disabled=true;$('#authError').textContent='';try{const mode=$('#authForm').dataset.mode,data=await api(mode==='setup'?'/api/setup':'/api/login',{method:'POST',body:JSON.stringify({username:$('#username').value.trim(),password:$('#password').value})});$('#password').value='';await enter(data.user);}catch(error){$('#authError').textContent=error.message;}finally{button.disabled=false;}});
$$('[data-view]').forEach(button=>button.addEventListener('click',()=>switchView(button.dataset.view)));
for(const eventName of ['pointerdown','keydown'])document.addEventListener(eventName,()=>{
  if(!state.user||companion.busy)return;
  if($('#companion').dataset.mood==='sleep')companionReact('idle','',0);
  else companionRest();
});
$$('#companion, #mobileCompanion').forEach(button=>{
  button.addEventListener('click',companionTip);
  button.addEventListener('pointerenter',()=>{if(!companion.busy&&['idle','sleep'].includes(button.dataset.mood))companionReact('wave','',1100);});
  button.addEventListener('focus',()=>{if(!companion.busy&&['idle','sleep'].includes(button.dataset.mood))companionReact('wave','',1100);});
});
$('#todayPicker').addEventListener('change',event=>{state.date=event.target.value||day(new Date());$('#weekPicker').value=state.date;render();});
$('#weekPicker').addEventListener('change',event=>{state.date=event.target.value||day(new Date());$('#todayPicker').value=state.date;render();});
$('#settleAll').addEventListener('click',event=>prepareAnalysis('all',null,event.currentTarget));
$('#settleWeek').addEventListener('click',event=>prepareAnalysis('week',null,event.currentTarget));
$('#analysisConsent').addEventListener('change',event=>{$('#confirmAnalysis').disabled=!event.target.checked;});
$('#confirmAnalysis').addEventListener('click',()=>{if(!state.pendingAnalysis||!$('#analysisConsent').checked)return;const previews=state.pendingAnalysis.previews;closeOverlay('analysisOverlay');runAnalysis(previews);});
$('#settlementHide').addEventListener('click',settlementHide);
$('#settlementDock').addEventListener('click',settlementOpen);
$('#settlementDone').addEventListener('click',()=>{$('#settlementOverlay').classList.add('hidden');$('#settlementDock').classList.add('hidden');switchView(settlement.items[0]?.kind==='week'?'week':'map');});
$('#addButton').addEventListener('click',()=>openEditor());
$('#recordKind').addEventListener('change',()=>{$('#durationField').classList.toggle('hidden',$('#recordKind').value==='project');});
$('#recordProject').addEventListener('change',()=>fillTasks());
document.addEventListener('click',event=>{
  const world=event.target.closest('[data-world]');if(world){showWorld(world.dataset.world);return;}
  const project=event.target.closest('[data-project]');if(project){state.selectedProject=project.dataset.project;renderLevels();switchView('levels');return;}
  const level=event.target.closest('[data-level]');if(level){openLevel(level.dataset.level);return;}
  const settle=event.target.closest('[data-settle-project]');if(settle){prepareAnalysis('project',settle.dataset.settleProject,settle);return;}
  const all=event.target.closest('[data-settle-all]');if(all){prepareAnalysis('all',null,all);return;}
  const edit=event.target.closest('[data-edit]');if(edit){closeOverlay('levelOverlay');openEditor(byId(edit.dataset.edit));return;}
  const atlas=event.target.closest('[data-open-atlas]');if(atlas){$('#skillAtlas').scrollIntoView({behavior:'smooth',block:'start'});return;}
  const close=event.target.closest('[data-close]');if(close)closeOverlay(close.dataset.close);
});
$$('.overlay').forEach(overlay=>overlay.addEventListener('click',event=>{if(event.target===overlay)closeOverlay(overlay.id);}));
$('#recordForm').addEventListener('submit',async event=>{event.preventDefault();const editing=state.editing,input={kind:$('#recordKind').value,source:editing?.source||'manual',title:$('#recordTitle').value.trim(),category:$('#recordCategory').value,status:$('#recordStatus').value,note:$('#recordNote').value.trim(),projectId:$('#recordProject').value||null,taskId:$('#recordTask').value||null};if(editing?.source!=='codex'){input.startedAt=new Date(`${$('#recordDate').value}T${$('#recordTime').value}:00`).toISOString();input.durationMinutes=input.kind==='project'||!$('#recordDuration').value?null:Number($('#recordDuration').value);}const button=$('#saveRecord');button.disabled=true;try{await api(editing?`/api/records/${editing.id}`:'/api/records',{method:editing?'PATCH':'POST',body:JSON.stringify(input)});closeOverlay('editorOverlay');await loadData();notice('旅程资料已保存。');}catch(error){notice(error.message,true);}finally{button.disabled=false;}});
$('#deleteRecord').addEventListener('click',async()=>{if(!state.editing||!confirm('确定删除这条记录吗？Codex 来源记录不会在下次同步时重新出现。'))return;try{await api(`/api/records/${state.editing.id}`,{method:'DELETE'});closeOverlay('editorOverlay');await loadData();notice('记录已删除。');}catch(error){notice(error.message,true);}});
$('#syncButton').addEventListener('click',async()=>{const button=$('#syncButton');button.disabled=true;button.textContent='接入中…';companionBusy('searching','正在寻找 Codex 留下的新足迹…');try{const result=await api('/api/codex/sync',{method:'POST',body:'{}'});await loadData();notice(`Codex 旅程已更新 · 新增 ${result.projectsAdded} 条路线、${result.added} 个关卡；更新 ${result.updated} 个关卡。`);companionFinish(true,result.added||result.projectsAdded?`发现 ${result.added} 个新关卡！`:'旅程已更新，暂时没有新关卡。');}catch(error){notice(error.message,true);companionFinish(false,'这次没能接上 Codex，看看上方提示吧。');}finally{button.disabled=false;button.textContent='↻ 接入 Codex';}});
$('#exportButton').addEventListener('click',async()=>{try{const data=await api('/api/export'),blob=new Blob([JSON.stringify(data,null,2)],{type:'application/json'}),url=URL.createObjectURL(blob),link=document.createElement('a');link.href=url;link.download=`ai-adventure-${day(new Date())}.json`;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);notice('存档已导出。');}catch(error){notice(error.message,true);}});
$('#logoutButton').addEventListener('click',async()=>{try{await api('/api/logout',{method:'POST',body:'{}'});}finally{state.user=null;state.records=[];companion.busy=false;clearTimeout(companion.reset);clearTimeout(companion.rest);companionReact('idle','',0);clearInterval(settlement.ticker);settlement.running=false;settlement.items=[];$('#settlementOverlay').classList.add('hidden');$('#settlementDock').classList.add('hidden');showAuth(false);}});
let settlementPolling=false;
setInterval(async()=>{
  if(!state.user||!settlement.running||settlementPolling)return;
  settlementPolling=true;
  try{
    const status=await api('/api/analysis/status');state.analysisStatus=status;
    if(status.active){settlement.phase=status.active.phase||'evaluating';settlementRender();}
    else if(settlement.recovered){
      const item=settlement.items[0],success=status.last?.status==='completed';
      item.status=success?'done':'failed';
      if(!success)settlement.errors.push(`${item.title}：${status.last?.failureReason==='timeout'?'研判超时':'研判未完成'}`);
      settlementEnd(Date.parse(status.last?.finishedAt)||Date.now());companionFinish(success,success?'宝箱打开啦！去地图上看看新收获。':'宝箱暂时没打开，稍后再试。');
      await loadData();
    }
  }catch{}finally{settlementPolling=false;}
},2500);
(async()=>{try{const session=await api('/api/session');if(session.user)await enter(session.user);else showAuth(session.setupRequired);}catch(error){showAuth(false);$('#authError').textContent=`无法连接本地服务：${error.message}`;}})();
