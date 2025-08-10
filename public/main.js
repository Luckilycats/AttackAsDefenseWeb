// main.js — 单房间 GLOBAL：自动联机 + 玩家/观战分配 + 顶部人数与阵营颜色 + 刷新投票
// 绘制优化：更激进抽样与装饰层跳过；子弹瞬间消失；BG 仅脏时重绘
// 注意：协议不变

/* ====================== 画布与 UI ====================== */
const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d', { alpha: true });

const btnRoad    = document.getElementById('btn-road');
const btnWall    = document.getElementById('btn-wall');
const btnTurret  = document.getElementById('btn-turret');
const btnCiws    = document.getElementById('btn-ciws');
const btnSniper  = document.getElementById('btn-sniper');
const btnDemo    = document.getElementById('btn-demo');
const btnCancel  = document.getElementById('btn-cancel');
const modeLabel  = document.getElementById('mode-label');
const goldEl     = document.getElementById('gold');
const toastEl    = document.getElementById('toast');
const buildButtons = [btnRoad, btnWall, btnTurret, btnCiws, btnSniper];

/* ====================== WS 基地址 ====================== */
const WS_URL = location.origin.startsWith('https')
  ? location.origin.replace(/^https/, 'wss')
  : location.origin.replace(/^http/,  'ws');

/* ====================== 颜色 ====================== */
const COLOR = {
  allyCore:'#2b7bff', allyRoad:'#6fa8ff', allyWall:'#1f5fe0',
  allyTurret:'#4f91ff', allyCiws:'#3a7aff', allySniper:'#1a54cc',
  enemyCore:'#ff3b3b', enemyRoad:'#ff7a7a', enemyWall:'#e02a2a',
  enemyTurret:'#ff5f5f', enemyCiws:'#ff4242', enemySniper:'#cc1a1a',
  rock:'#7b7b7b', gold:'#d8b401', gridA:'#2a2a2a', gridB:'#242424',
  resStroke:'#1a1a1a', ally:'#2b7bff', allyLight:'#75a9ff',
  enemy:'#ff3b3b', enemyLight:'#ff8a8a'
};

/* ===== 顶部身份/人数/阵营颜色标签 ===== */
const youEl = document.createElement('span');
youEl.id='you-label'; youEl.style.marginLeft='12px';

const roomEl = document.createElement('span');
roomEl.id='room-label'; roomEl.style.marginLeft='12px';

const teamEl = document.createElement('span');
teamEl.id='team-label';
teamEl.style.marginLeft = '12px';
teamEl.style.padding = '2px 6px';
teamEl.style.borderRadius = '6px';
teamEl.style.border = '1px solid #666';
teamEl.style.background = '#1f1f1f';
teamEl.style.color = '#eaeaea';
teamEl.textContent = '';

const topbar = document.getElementById('topbar');
topbar?.appendChild(youEl);
topbar?.appendChild(roomEl);
topbar?.appendChild(teamEl);

/* ===== 左侧按钮：攻击范围 / 刷新地图 ===== */
const btnToggleArcs = document.createElement('button');
btnToggleArcs.textContent='显示攻击范围';
Object.assign(btnToggleArcs.style,{
  position:'fixed',left:'12px',top:'46%',transform:'translateY(-50%)',
  padding:'8px 10px',border:'1px solid #666',background:'#1f1f1f',
  color:'#eaeaea',cursor:'pointer',zIndex:9999,borderRadius:'6px'
});
document.body.appendChild(btnToggleArcs);

const btnRefresh = document.createElement('button');
btnRefresh.textContent='刷新地图';
Object.assign(btnRefresh.style,{
  position:'fixed',left:'12px',top:'56%',transform:'translateY(-50%)',
  padding:'8px 10px',border:'1px solid #666',background:'#1f1f1f',
  color:'#eaeaea',cursor:'pointer',zIndex:9999,borderRadius:'6px',display:'none'
});
document.body.appendChild(btnRefresh);

/* ====================== 常量/工具 ====================== */
const CELL=8;
const DIR_TO_RAD = [0, Math.PI/2, Math.PI, -Math.PI/2];
const GHOST_FADE_T = 0.25;
const GHOST_TIMEOUT = 1.0;
const MAX_SEND_PER_FRAME = 160;
const MAX_PROCESS_PER_FRAME = 400;

function deg2rad(d){ return d*Math.PI/180; }
function clamp(v,a,b){ return Math.max(a,Math.min(b,v)); }

/* ====================== 性能状态 ====================== */
let _lastFrameCostMs = 0;
let _skipDecor = false;

/* ====================== 角色/模式 ====================== */
let ROLE = 'spectator';
let showArcs=false;
let mode='browse';
let selectedType=null;
let buildFacingDir=0;
let lastConfirmedDir=0;

let hoverX=-1, hoverY=-1;
let isMouseDown=false, selecting=false;
let selectStart=null, selectEnd=null;
let activePointerId=null;

/* ===== 刷新投票本地状态 ===== */
let refreshPending = false;
let refreshDeadline = 0;
let refreshTicker = null;

/* ====================== 服务器快照 ====================== */
const S = {
  you: 0, W:100, H:100,
  gold:{1:0,2:0}, core:{p1:1000,p2:1000},
  map:new Uint8Array(100*100),
  hp:new Uint16Array(100*100),
  owner:new Uint8Array(100*100),
  turrets:[]
};

/* ====================== 本地容器 ====================== */
const Local = { bullets:new Map(), arr:[] };
const Ghost = {
  items:new Map(), placedKeySet:new Set(),
  queue:[], pendingSet:new Set(), cellQueue:[]
};

/* ====================== 背景缓存 ====================== */
let bgCanvas=null, bgCtx=null, bgDirty=true;

/* ====================== 事件/UI ====================== */
btnToggleArcs.onclick = ()=>{
  showArcs=!showArcs;
  btnToggleArcs.textContent = showArcs?'隐藏攻击范围':'显示攻击范围';
};

btnRefresh.onclick = ()=>{
  if(ROLE!=='player' || refreshPending) return;
  Net.refreshRequest();
  setRefreshPending(true, null);
};

function setRefreshPending(pending, deadline){
  refreshPending = pending;
  refreshDeadline = deadline || 0;
  if(ROLE==='player'){
    btnRefresh.disabled = pending;
    btnRefresh.textContent = pending ? '等待同意…' : '刷新地图';
  }
  if(refreshTicker){ clearInterval(refreshTicker); refreshTicker=null; }
  if(pending && deadline){
    refreshTicker = setInterval(()=>{
      const left = Math.max(0, Math.ceil((deadline - Date.now())/1000));
      if(left<=0){ clearInterval(refreshTicker); refreshTicker=null; }
      if(ROLE==='player'){ btnRefresh.textContent = `等待同意…（${left}s）`; }
    }, 500);
  }
}

function labelOf(t){ return t==='road'?'道路':t==='wall'?'围墙':t==='turret'?'基础炮':t==='ciws'?'近防炮':t==='sniper'?'狙击炮':''; }
function updateHUD(){
  if(ROLE==='player'){
    goldEl.textContent=S.gold[S.you]||0;
    youEl.textContent=S.you?`你是：P${S.you}`:'';
    if (S.you===1){
      teamEl.textContent = '阵营颜色：蓝';
      teamEl.style.borderColor = COLOR.ally;
      teamEl.style.color = '#eaeaea';
    }else if(S.you===2){
      teamEl.textContent = '阵营颜色：红';
      teamEl.style.borderColor = COLOR.enemy;
      teamEl.style.color = '#eaeaea';
    }else{
      teamEl.textContent = '';
    }
  }else{
    goldEl.textContent='—';
    youEl.textContent='观战中';
    teamEl.textContent = '';
  }
}
function updateRoomLabel(playerCount=0, spectatorCount=0){
  roomEl.textContent = `玩家：${playerCount}/2 | 观战：${spectatorCount}`;
}
function toast(msg,ms=1000){
  toastEl.textContent=msg; toastEl.hidden=false;
  clearTimeout(toastEl._t); toastEl._t=setTimeout(()=>toastEl.hidden=true,ms);
}

/* ====================== 模式 ====================== */
function enterBuildMode(type){
  if(ROLE!=='player') return;
  mode='build'; selectedType=type;
  buildButtons.forEach(b=>b.classList.toggle('active', b.dataset.type===type));
  btnDemo.classList.remove('active');
  buildFacingDir = (type==='ciws') ? 0 : lastConfirmedDir;
  modeLabel.textContent = `建造模式：${labelOf(type)}（R旋转，长按连续建造）`;
}
function enterDemolishMode(){
  if(ROLE!=='player') return;
  mode='demolish'; selectedType=null;
  buildButtons.forEach(b=>b.classList.remove('active'));
  btnDemo.classList.add('active');
  modeLabel.textContent='拆除模式：拖拽框选，松开后批量拆除（返还50%）';
}
function enterBrowseMode(){
  mode='browse'; selectedType=null;
  buildButtons.forEach(b=>b.classList.remove('active'));
  btnDemo.classList.remove('active');
  modeLabel.textContent='浏览模式（F1 查看帮助）';
  selecting=false; selectStart=null; selectEnd=null;
}
function initUI(){
  btnRoad.onclick   = ()=>enterBuildMode('road');
  btnWall.onclick   = ()=>enterBuildMode('wall');
  btnTurret.onclick = ()=>enterBuildMode('turret');
  btnCiws.onclick   = ()=>enterBuildMode('ciws');
  btnSniper.onclick = ()=>enterBuildMode('sniper');
  btnDemo.onclick   = ()=>enterDemolishMode();
  btnCancel.onclick = ()=>enterBrowseMode();

  window.addEventListener('keydown',(e)=>{
    const k=e.key.toLowerCase();
    if(ROLE!=='player'){ if(k==='escape'||k==='esc') enterBrowseMode(); return; }
    if(k==='1') enterBuildMode('road');
    else if(k==='2') enterBuildMode('wall');
    else if(k==='3') enterBuildMode('turret');
    else if(k==='4') enterBuildMode('ciws');
    else if(k==='5') enterBuildMode('sniper');
    else if(k==='d') enterDemolishMode();
    else if(k==='r'){ if(mode==='build'&&selectedType){ buildFacingDir=(buildFacingDir+1)&3; } }
    else if(e.key==='Escape'||e.key==='Esc') enterBrowseMode();
  });
}

/* ====================== 坐标/取色/校验 ====================== */
const CELL_F = CELL; // 常量别名，便于 JIT
function pointerToCell(e){ const r=canvas.getBoundingClientRect(); const px=e.clientX-r.left, py=e.clientY-r.top; return {px,py,mx:Math.floor(px/CELL_F),my:Math.floor(py/CELL_F)}; }
function getFootprint(type, dir){
  if(type==='turret') return {w:2,h:2};
  if(type==='ciws')   return (dir===0||dir===2)?{w:3,h:2}:{w:2,h:3};
  if(type==='sniper') return {w:4,h:4};
  if(type==='road'||type==='wall') return {w:1,h:1};
  return {w:1,h:1};
}
function colorForCell(v, ownerTeam){
  const t1 = (ownerTeam===1);
  switch(v){
    case 1: return COLOR.rock; case 2: return COLOR.gold;
    case 3: case 4: return t1?COLOR.allyCore:COLOR.enemyCore;
    case 10: return t1?COLOR.allyRoad:COLOR.enemyRoad;
    case 11: return t1?COLOR.allyWall:COLOR.enemyWall;
    case 12: return t1?COLOR.allyTurret:COLOR.enemyTurret;
    case 13: return t1?COLOR.allyCiws:COLOR.enemyCiws;
    case 14: return t1?COLOR.allySniper:COLOR.enemySniper;
    default: return null;
  }
}
function colorForTypeByTeam(type, team){
  const t1=(team===1);
  if(t1){
    if(type==='core')return COLOR.allyCore; if(type==='road')return COLOR.allyRoad; if(type==='wall')return COLOR.allyWall;
    if(type==='turret')return COLOR.allyTurret; if(type==='ciws')return COLOR.allyCiws; if(type==='sniper')return COLOR.allySniper;
  }else{
    if(type==='core')return COLOR.enemyCore; if(type==='road')return COLOR.enemyRoad; if(type==='wall')return COLOR.enemyWall;
    if(type==='turret')return COLOR.enemyTurret; if(type==='ciws')return COLOR.enemyCiws; if(type==='sniper')return COLOR.enemySniper;
  }
  return t1?COLOR.ally:COLOR.enemy;
}
function inBounds(x,y){ return x>=0&&y>=0&&x<S.W&&y<S.H; }
function rectInBounds(x,y,w,h){ return x>=0&&y>=0&&(x+w)<=S.W&&(y+h)<=S.H; }
function areaEmptyClient(x,y,w,h){ for(let j=0;j<h;j++)for(let i=0;i<w;i++){ if(S.map[(y+j)*S.W+(x+i)]!==0) return false; } return true; }

/* 仅允许在“己方建筑相邻”处建造（客户端粗校验） */
function rectCanBuildHereClient(x,y,w,h){
  const xmin=Math.max(0,x-1), xmax=Math.min(S.W-1,x+w);
  const ymin=Math.max(0,y-1), ymax=Math.min(S.H-1,y+h);
  for(let yy=ymin;yy<=ymax;yy++){
    for(let xx=xmin;xx<=xmax;xx++){
      const onPerimeter=(xx<x||xx>=x+w||yy<y||yy>=y+h);
      if(!onPerimeter) continue;
      const i=yy*S.W+xx;
      const v=S.map[i];
      const o=S.owner[i];
      const isBuilding = (v===3||v===4||v===10||v===11||v===12||v===13||v===14);
      if(isBuilding && o===S.you) return true;
    }
  }
  return false;
}

/* ====================== Supercover ====================== */
function supercoverLineCells(x0,y0,x1,y1){
  const cells=[]; let dx=x1-x0, dy=y1-y0;
  const sx=Math.sign(dx)||1, sy=Math.sign(dy)||1; dx=Math.abs(dx); dy=Math.abs(dy);
  let x=x0, y=y0; cells.push({x,y});
  if(dx>=dy){ let f=0; for(let i=0;i<dx;i++){ x+=sx; f+=dy; if(f>=dx){ y+=sy; f-=dx; cells.push({x,y}); } cells.push({x,y}); } }
  else{ let f=0; for(let i=0;i<dy;i++){ y+=sy; f+=dx; if(f>=dy){ x+=sx; f-=dy; cells.push({x,y}); } cells.push({x,y}); } }
  const out=[]; const seen=new Set(); for(const c of cells){ const k=c.x+'|'+c.y; if(!seen.has(k)){ seen.add(k); out.push(c);} } return out;
}

/* ====================== 箭头 Path2D ====================== */
const ARROW_PATHS = (() => {
  const mk = (rot90) => {
    const p = new Path2D();
    const pts = [{x:+0.5,y:0.0},{x:-0.5,y:-0.3},{x:-0.5,y:+0.3}];
    const sin=[0,1,0,-1][rot90], cos=[1,0,-1,0][rot90];
    const rx=(x,y)=>({x:x*cos-y*sin,y:x*sin+y*cos});
    const a=rx(pts[0].x,pts[0].y), b=rx(pts[1].x,pts[1].y), c=rx(pts[2].x,pts[2].y);
    p.moveTo(a.x,a.y); p.lineTo(b.x,b.y); p.lineTo(c.x,c.y); p.closePath(); return p;
  };
  return [mk(0),mk(1),mk(2),mk(3)];
})();
function drawArrowFast(cx,cy,facingDir,size,color,alpha=1){
  const p=ARROW_PATHS[(facingDir|0)&3], s=Math.max(size,1);
  ctx.save(); ctx.translate(cx,cy); ctx.scale(s,s); ctx.globalAlpha=alpha;
  ctx.lineJoin='round'; ctx.lineCap='round';
  ctx.strokeStyle='rgba(0,0,0,0.95)'; ctx.lineWidth=Math.max(2.2,size*0.14)/s; ctx.stroke(p);
  ctx.fillStyle=color; ctx.fill(p);
  ctx.strokeStyle='rgba(255,255,255,0.75)'; ctx.lineWidth=Math.max(1.2,size*0.06)/s; ctx.stroke(p);
  ctx.restore();
}

/* ====================== 幽灵/发送 ====================== */
function enqueueGhostAndSend(type,x,y,dir){
  if(ROLE!=='player') return;
  const fp=getFootprint(type,dir);
  const key=`${x},${y},${fp.w}x${fp.h}`;
  if(Ghost.pendingSet.has(key)) return;
  if(!rectInBounds(x,y,fp.w,fp.h)) return;
  if(!areaEmptyClient(x,y,fp.w,fp.h)) return;
  if(!rectCanBuildHereClient(x,y,fp.w,fp.h)) return;

  Ghost.pendingSet.add(key);
  Ghost.queue.push({x,y,type,dir,key});
  Ghost.items.set(key,{x,y,w:fp.w,h:fp.h,type,dir,team:S.you||1,alpha:0.9,t0:performance.now(),status:'pending'});
}
function flushBuildQueue(){
  if(ROLE!=='player') return;
  let q=MAX_SEND_PER_FRAME;
  while(q>0 && Ghost.queue.length){
    const it=Ghost.queue.shift(); q--;
    Net.build(it.type,it.x,it.y,it.dir);
    const g=Ghost.items.get(it.key); if(g){ g.t0=performance.now(); g.status='pending'; }
  }
}

/* ====================== 指针事件 ====================== */
let lastDragCell=null;
function initPointer(){
  function handleMoveLike(e){
    const p=pointerToCell(e); hoverX=p.mx; hoverY=p.my;
    if(isMouseDown && activePointerId===e.pointerId){
      if(mode==='build'&&selectedType&&ROLE==='player'){
        if(lastDragCell==null){ lastDragCell={x:p.mx,y:p.my}; Ghost.cellQueue.push({x:p.mx,y:p.my}); }
        else{ const list=supercoverLineCells(lastDragCell.x,lastDragCell.y,p.mx,p.my); for(const c of list) Ghost.cellQueue.push(c); lastDragCell={x:p.mx,y:p.my}; }
      }else if(mode==='demolish'&&selecting&&ROLE==='player'){ selectEnd={x:p.mx,y:p.my}; }
    }
  }
  canvas.addEventListener('pointerrawupdate',handleMoveLike);
  canvas.addEventListener('pointermove',handleMoveLike);

  canvas.addEventListener('pointerdown',(e)=>{
    if(e.button!==0) return;
    activePointerId=e.pointerId; canvas.setPointerCapture(activePointerId);
    const p=pointerToCell(e); isMouseDown=true;
    if(ROLE==='player'&&mode==='build'&&selectedType){
      Ghost.placedKeySet.clear(); lastDragCell={x:p.mx,y:p.my}; Ghost.cellQueue.push({x:p.mx,y:p.my});
    }else if(ROLE==='player'&&mode==='demolish'){
      selecting=true; selectStart={x:p.mx,y:p.my}; selectEnd={x:p.mx,y:p.my};
    }
  });
  function endPointer(e){
    if(e.pointerId!==activePointerId) return;
    isMouseDown=false; activePointerId=null; lastDragCell=null;
    if(ROLE==='player'&&mode==='demolish'&&selecting&&selectStart&&selectEnd){
      Net.demolish(selectStart.x,selectStart.y,selectEnd.x,selectEnd.y);
    }
    selecting=false; selectStart=null; selectEnd=null;
    try{ canvas.releasePointerCapture(e.pointerId); }catch{}
  }
  canvas.addEventListener('pointerup',endPointer);
  canvas.addEventListener('pointercancel',endPointer);
  canvas.addEventListener('contextmenu',(e)=>e.preventDefault());
}

/* ====================== RAF 消费建造格 ====================== */
function consumeCellQueue(){
  let quota=MAX_PROCESS_PER_FRAME;
  while(quota>0 && Ghost.cellQueue.length){
    const c=Ghost.cellQueue.shift(); quota--;
    if(!inBounds(c.x,c.y)) continue;
    const fp=getFootprint(selectedType||'road',buildFacingDir);
    const k=`${c.x},${c.y},${fp.w}x${fp.h}`;
    if(Ghost.placedKeySet.has(k)) continue;
    Ghost.placedKeySet.add(k);
    if(mode==='build'&&selectedType&&ROLE==='player'){
      enqueueGhostAndSend(selectedType,c.x,c.y,buildFacingDir);
      lastConfirmedDir=buildFacingDir;
    }
  }
}

/* ====================== 自动联机 ====================== */
function connectOnlineAuto(){
  const name='Guest-'+Math.random().toString(36).slice(2,6).toUpperCase();

  Net.onRoom = (m)=>{ updateRoomLabel(m.playerCount||0, m.spectatorCount||0); };
  Net.onStart = (m)=>{
    ROLE=m.role||'spectator';
    S.you = (ROLE==='player') ? (m.you|0) : 0;
    S.W=m.W; S.H=m.H;
    canvas.width=S.W*CELL; canvas.height=S.H*CELL;
    bgDirty=true; updateHUD();

    const controls = [...buildButtons, btnDemo, btnCancel];
    if (ROLE === 'spectator') {
      controls.forEach(b => b.setAttribute('disabled','disabled'));
      btnRefresh.style.display='none';
      enterBrowseMode();
    } else {
      controls.forEach(b => b.removeAttribute('disabled'));
      btnRefresh.style.display='block';
      btnRefresh.disabled = false;
      btnRefresh.textContent='刷新地图';
    }
  };
  Net.onState = (m)=>{
    // S.hp 在前端不参与绘制与判定，但沿用协议
    S.gold=m.gold; S.core=m.core;
    S.map=new Uint8Array(m.map); S.hp=new Uint16Array(m.hp); S.owner=new Uint8Array(m.owner);
    S.turrets=m.turrets; bgDirty=true;
    reconcileBulletsFromServer(m.bullets);
    updateHUD();
    reconcileGhostsWithServer();
  };
  Net.onEnded = (m)=>{ toast(m.winner===S.you?'你获胜':'你失败',3000); };
  Net.onError = (e)=>{ alert('联机错误：'+(e.code||'UNKNOWN')); };

  // 刷新投票消息
  Net.onRefreshPrompt = (m)=>{
    if(ROLE==='player'){
      const ok = confirm('对方请求刷新地图，是否同意？（20 秒内有效）');
      Net.refreshVote(!!ok);
    }
  };
  Net.onRefreshStatus = (m)=>{
    setRefreshPending(true, m.deadline||0);
    toast('刷新投票进行中', 1500);
  };
  Net.onRefreshResult = (m)=>{
    setRefreshPending(false, 0);
    if(m.ok){
      Local.bullets.clear(); Local.arr=[];
      Ghost.items.clear(); Ghost.pendingSet.clear(); Ghost.queue.length=0; Ghost.cellQueue.length=0;
      bgDirty=true;
      toast('地图已刷新', 1500);
    }else{
      const msg = m.reason==='rejected'?'对方已拒绝刷新':m.reason==='timeout'?'刷新请求已超时':m.reason==='busy'?'已有进行中的刷新投票':'刷新失败';
      toast(msg, 1500);
    }
  };

  (function waitNet(){
    if (window.Net && typeof Net.connect==='function') Net.connect({ name });
    else setTimeout(waitNet,10);
  })();
}

/* ====================== 幽灵对齐 ====================== */
function reconcileGhostsWithServer(){
  const now=performance.now();
  for(const [key,g] of Ghost.items){
    let ok=true;
    for(let j=0;j<g.h;j++){ for(let i=0;i<g.w;i++){
      const idx=(g.y+j)*S.W+(g.x+i); const v=S.map[idx], o=S.owner[idx];
      let expectV=0;
      if(g.type==='core')expectV=(g.team===1)?3:4;
      if(g.type==='road')expectV=10; if(g.type==='wall')expectV=11; if(g.type==='turret')expectV=12;
      if(g.type==='ciws')expectV=13; if(g.type==='sniper')expectV=14;
      if(v!==expectV || o!==g.team){ ok=false; break; }
    } if(!ok) break; }
    if(ok){ Ghost.items.delete(key); Ghost.pendingSet.delete(key); }
    else if((now-g.t0)/1000>GHOST_TIMEOUT && g.status==='pending'){ g.status='rejected'; g.alpha=0.9; }
  }
}

/* ====================== 子弹融合（瞬间消失 + 更激进抽样） ====================== */
function reconcileBulletsFromServer(list){
  const seen=new Set();
  for(const sb of list){
    seen.add(sb.id);
    const lb=Local.bullets.get(sb.id);
    if(!lb){ Local.bullets.set(sb.id,{x:sb.x,y:sb.y,vx:sb.vx,vy:sb.vy,team:sb.team,dead:false}); }
    else{
      const blend=0.2; lb.x += (sb.x-lb.x)*blend; lb.y += (sb.y-lb.y)*blend;
      lb.vx=sb.vx; lb.vy=sb.vy; lb.team=sb.team; lb.dead=false;
    }
  }
  for(const [id] of Local.bullets){ if(!seen.has(id)) Local.bullets.delete(id); }
  // 构建线性数组供批量绘制
  Local.arr = Array.from(Local.bullets.values());
}
function updateLocal(dt){
  for(const [id,b] of Local.bullets){
    if(b.dead){ Local.bullets.delete(id); continue; }
    b.x += b.vx*dt; b.y += b.vy*dt;
  }
  const del=[]; for(const [k,g] of Ghost.items){ if(g.status==='rejected'){ g.alpha -= dt/GHOST_FADE_T; if(g.alpha<=0) del.push(k);} }
  for(const k of del){ Ghost.items.delete(k); Ghost.pendingSet.delete(k); }
}

/* ====================== 背景绘制 ====================== */
function ensureBG(){
  if(!bgCanvas || bgCanvas.width!==canvas.width || bgCanvas.height!==canvas.height){
    bgCanvas=document.createElement('canvas'); bgCanvas.width=canvas.width; bgCanvas.height=canvas.height; bgCtx=bgCanvas.getContext('2d'); bgDirty=true;
  }
  if(!bgDirty) return;
  const W=S.W,H=S.H, cell=CELL_F;
  for(let y=0;y<H;y++) for(let x=0;x<W;x++){ bgCtx.fillStyle=((x+y)&1)?COLOR.gridA:COLOR.gridB; bgCtx.fillRect(x*cell,y*cell,cell,cell); }
  for(let y=0;y<H;y++) for(let x=0;x<W;x++){
    const idx=y*W+x, v=S.map[idx]; if(!v) continue;
    const o=S.owner[idx], fill=colorForCell(v,o); if(!fill) continue;
    bgCtx.fillStyle=fill; bgCtx.fillRect(x*cell,y*cell,cell,cell);
    if(v===1||v===2){ bgCtx.lineWidth=0.75; bgCtx.strokeStyle=COLOR.resStroke; bgCtx.strokeRect(x*cell+0.35,y*cell+0.35,cell-0.7,cell-0.7); }
  }
  bgDirty=false;
}

/* ====================== 幽灵与主绘制 ====================== */
function drawGhosts(){
  const groups=new Map();
  const add=(k,color,x,y,w,h,a)=>{ let g=groups.get(k); if(!g){ g={path:new Path2D(),color,alphaSum:0,count:0}; groups.set(k,g);} g.path.rect(x*CELL_F,y*CELL_F,w*CELL_F,h*CELL_F); g.alphaSum+=a; g.count++; };
  for(const g of Ghost.items.values()){
    const fill=colorForTypeByTeam(g.type,g.team||1);
    const alpha=clamp(g.alpha,0,0.9)*0.7; if(alpha<=0) continue;
    add(g.type+'-'+(g.team||1),fill,g.x,g.y,g.w,g.h,alpha);
  }
  for(const {path,color,alphaSum,count} of groups.values()){
    ctx.save(); ctx.globalAlpha=(count?alphaSum/count:0.5); ctx.fillStyle=color; ctx.fill(path); ctx.restore();
  }
  if(_skipDecor) return;
  for(const g of Ghost.items.values()){
    const arc=(g.type==='turret')?90:(g.type==='ciws')?180:(g.type==='sniper')?45:(g.type==='core')?360:0;
    // 与服务器一致：turret=16, ciws=6, sniper=40, core=16
    const range=(g.type==='turret')?16:(g.type==='ciws')?6:(g.type==='sniper')?40:(g.type==='core')?16:0;
    if(arc>0){
      const cenDir=(g.type==='ciws')?((g.dir+1)&3):g.dir;
      const cx=(g.x+g.w*0.5)*CELL_F, cy=(g.y+g.h*0.5)*CELL_F, r=range*CELL_F;
      ctx.save(); ctx.globalAlpha=0.16; ctx.fillStyle=(g.team===1)?COLOR.allyLight:COLOR.enemyLight;
      if(arc<360){ const center=DIR_TO_RAD[cenDir|0]; ctx.beginPath(); const a0=center-deg2rad(arc)/2, a1=center+deg2rad(arc)/2; ctx.moveTo(cx,cy); ctx.arc(cx,cy,r,a0,a1); ctx.closePath(); ctx.fill(); }
      else{ ctx.beginPath(); ctx.arc(cx,cy,r,0,Math.PI*2); ctx.closePath(); ctx.fill(); }
      ctx.restore();
      if(g.type!=='core'){ drawArrowFast(cx,cy,cenDir,Math.min(g.w,g.h)*CELL_F*0.9,(g.team===1)?COLOR.ally:COLOR.enemy,0.9); }
    }
  }
}
function draw(){
  ensureBG(); ctx.drawImage(bgCanvas,0,0);

  if(showArcs && !_skipDecor){
    for(const t of S.turrets){
      const r=t.rangeCells*CELL_F, colorFill=(t.team===1)?COLOR.allyLight:COLOR.enemyLight;
      if(t.arcDeg<360){ const center=DIR_TO_RAD[t.facingDir|0]; ctx.save(); ctx.globalAlpha=0.12; ctx.fillStyle=colorFill;
        ctx.beginPath(); const a0=center-deg2rad(t.arcDeg)/2, a1=center+deg2rad(t.arcDeg)/2; ctx.moveTo(t.cx*CELL_F,t.cy*CELL_F); ctx.arc(t.cx*CELL_F,t.cy*CELL_F,r,a0,a1);
        ctx.closePath(); ctx.fill(); ctx.restore(); }
      else{ ctx.save(); ctx.globalAlpha=0.12; ctx.fillStyle=colorFill; ctx.beginPath(); ctx.arc(t.cx*CELL_F,t.cy*CELL_F,r,0,Math.PI*2); ctx.closePath(); ctx.fill(); ctx.restore(); }
    }
  }
  if(!_skipDecor){
    for(const t of S.turrets){ if(t.role==='core') continue; const color=(t.team===1)?COLOR.ally:COLOR.enemy; drawArrowFast(t.cx*CELL_F,t.cy*CELL_F,t.facingDir,Math.min(t.w,t.h)*CELL_F*0.9,color,0.9); }
  }

  // 幽灵
  drawGhosts();

  // 子弹批量绘制（更激进抽样）
  const arr=Local.arr, n=arr.length;
  const step = (n>1600)?4:(n>1000)?3:(n>600)?2:1;
  ctx.fillStyle='#ffffff'; ctx.beginPath(); for(let i=0;i<n;i+=step){ const b=arr[i]; if(b.team===1) ctx.rect(b.x*CELL_F-2,b.y*CELL_F-2,4,4); } ctx.fill();
  ctx.fillStyle='#ffd1d1'; ctx.beginPath(); for(let i=0;i<n;i+=step){ const b=arr[i]; if(b.team===2) ctx.rect(b.x*CELL_F-2,b.y*CELL_F-2,4,4); } ctx.fill();

  if(ROLE==='player'&&mode==='build'&&selectedType&&hoverX>=0&&hoverY>=0){
    const fp=getFootprint(selectedType,buildFacingDir);
    const ok=rectInBounds(hoverX,hoverY,fp.w,fp.h)
           && areaEmptyClient(hoverX,hoverY,fp.w,fp.h)
           && rectCanBuildHereClient(hoverX,hoverY,fp.w,fp.h);
    ctx.globalAlpha=0.33; ctx.fillStyle= ok?COLOR.ally:COLOR.enemy; ctx.fillRect(hoverX*CELL_F,hoverY*CELL_F,fp.w*CELL_F,fp.h*CELL_F); ctx.globalAlpha=1;
    ctx.lineWidth=1; ctx.strokeStyle=ok?COLOR.allyLight:COLOR.enemyLight; ctx.strokeRect(hoverX*CELL_F+0.5,hoverY*CELL_F+0.5,fp.w*CELL_F-1,fp.h*CELL_F-1);

    if(!_skipDecor){
      const arc=(selectedType==='turret')?90:(selectedType==='ciws')?180:(selectedType==='sniper')?45:(selectedType==='core')?360:0;
      const range=(selectedType==='turret')?16:(selectedType==='ciws')?6:(selectedType==='sniper')?40:(selectedType==='core')?16:0;
      if(arc>0){
        const cx=(hoverX+fp.w*0.5)*CELL_F, cy=(hoverY+fp.h*0.5)*CELL_F;
        const cenDir=(selectedType==='ciws')?((buildFacingDir+1)&3):buildFacingDir;
        const center=DIR_TO_RAD[cenDir|0], r=range*CELL_F;
        if(arc<360){ ctx.save(); ctx.globalAlpha=0.20; ctx.fillStyle=ok?COLOR.ally:COLOR.enemy; ctx.beginPath(); const a0=center-deg2rad(arc)/2, a1=center+deg2rad(arc)/2; ctx.moveTo(cx,cy); ctx.arc(cx,cy,r,a0,a1); ctx.closePath(); ctx.fill(); ctx.restore(); }
        else{ ctx.save(); ctx.globalAlpha=0.20; ctx.fillStyle=ok?COLOR.ally:COLOR.enemy; ctx.beginPath(); ctx.arc(cx,cy,r,0,Math.PI*2); ctx.closePath(); ctx.fill(); ctx.restore(); }
        if(selectedType!=='core'){ drawArrowFast(cx,cy,cenDir,Math.min(fp.w,fp.h)*CELL_F*0.9,COLOR.ally,0.9); }
      }
    }
  }else if(ROLE==='player'&&mode==='demolish'&&selecting&&selectStart&&selectEnd){
    const x0=Math.min(selectStart.x,selectEnd.x)*CELL_F, x1=(Math.max(selectStart.x,selectEnd.x)+1)*CELL_F;
    const y0=Math.min(selectStart.y,selectEnd.y)*CELL_F, y1=(Math.max(selectStart.y,selectEnd.y)+1)*CELL_F;
    const w=x1-x0, h=y1-y0; ctx.globalAlpha=0.25; ctx.fillStyle=COLOR.enemy; ctx.fillRect(x0,y0,w,h); ctx.globalAlpha=1;
    ctx.lineWidth=2; ctx.setLineDash([6,4]); ctx.strokeStyle=COLOR.enemyLight; ctx.strokeRect(x0+1,y0+1,w-2,h-2); ctx.setLineDash([]);
  }
}

/* ====================== 帧循环 ====================== */
let _rafLast=performance.now();
function loop(ts){
  const t0=performance.now();
  const dt=Math.min(0.05,(ts-_rafLast)/1000); _rafLast=ts;
  consumeCellQueue(); flushBuildQueue(); updateLocal(dt); draw();
  const used=performance.now()-t0; _lastFrameCostMs=used; _skipDecor = used>14; // 更激进：>14ms 即跳过装饰
  requestAnimationFrame(loop);
}

/* ====================== 启动 ====================== */
function initAll(){
  // 降低抗锯齿成本
  ctx.imageSmoothingEnabled = false;
  initUI(); initPointer(); updateHUD();
  window.addEventListener('load', () => setTimeout(connectOnlineAuto, 0));
  requestAnimationFrame(loop);
}
initAll();

/* ====================== Net 传输层（同源；固定 GLOBAL） ====================== */
(function(){
  if (window.Net) return;
  const Net = {}; let ws=null;
  Net.onRoom=()=>{}; Net.onStart=()=>{}; Net.onState=()=>{}; Net.onEnded=()=>{}; Net.onError=(e)=>{console.error(e);};
  Net.onRefreshPrompt=()=>{}; Net.onRefreshStatus=()=>{}; Net.onRefreshResult=()=>{};

  Net.connect=function({name='Guest'}={}){
    ws=new WebSocket(WS_URL);
    ws.onopen=()=>{ ws.send(JSON.stringify({type:'join', name})); };
    ws.onmessage=(ev)=>{ let m; try{ m=JSON.parse(ev.data);}catch{ return; }
      switch(m.type){
        case 'room': Net.onRoom(m); break;
        case 'start': Net.onStart(m); break;
        case 'state': Net.onState(m); break;
        case 'ended': Net.onEnded(m); break;
        case 'refresh_prompt': Net.onRefreshPrompt(m); break;
        case 'refresh_status': Net.onRefreshStatus(m); break;
        case 'refresh_result': Net.onRefreshResult(m); break;
        default: break;
      }
    };
    ws.onerror=(e)=>Net.onError(e);
    ws.onclose=()=>{};
    Net._ws=ws;
  };
  Net.ready=function(){};
  Net.build=function(kind,x,y,dir){ ws && ws.send(JSON.stringify({type:'build',kind,x,y,dir})); };
  Net.demolish=function(x0,y0,x1,y1){ ws && ws.send(JSON.stringify({type:'demolish',x0,y0,x1,y1})); };
  Net.refreshRequest=function(){ ws && ws.send(JSON.stringify({type:'refresh_request'})); };
  Net.refreshVote=function(accept){ ws && ws.send(JSON.stringify({type:'refresh_vote', accept: !!accept})); };
  window.Net=Net;
})();
