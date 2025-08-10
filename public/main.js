// main.js — 单房间 + 观战 + 人数显示；移除小地图
// 保留性能优化：Path2D 箭头、子弹瞬时消失、降采样绘制、装饰层自适应跳过

// —— 画布与 UI —— //
const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');

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

// 顶栏元素：身份与人数
const youEl = document.createElement('span');
youEl.id='you-label';
youEl.style.marginLeft='12px';
const countsEl = document.createElement('span');
countsEl.id='counts-label';
countsEl.style.marginLeft='12px';
document.getElementById('topbar')?.appendChild(youEl);
document.getElementById('topbar')?.appendChild(countsEl);

// —— 同源 WebSocket —— //
const WS_URL = location.origin.startsWith('https')
  ? location.origin.replace(/^https/, 'wss')
  : location.origin.replace(/^http/,  'ws');

// —— 颜色 —— //
const COLOR = {
  allyCore:'#2b7bff', allyRoad:'#6fa8ff', allyWall:'#1f5fe0', allyTurret:'#4f91ff', allyCiws:'#3a7aff', allySniper:'#1a54cc',
  enemyCore:'#ff3b3b', enemyRoad:'#ff7a7a', enemyWall:'#e02a2a', enemyTurret:'#ff5f5f', enemyCiws:'#ff4242', enemySniper:'#cc1a1a',
  rock:'#7b7b7b', gold:'#d8b401',
  gridA:'#2a2a2a', gridB:'#242424', resStroke:'#1a1a1a',
  ally:'#2b7bff', allyLight:'#75a9ff', enemy:'#ff3b3b', enemyLight:'#ff8a8a',
};

// —— 攻击范围开关按钮（保留） —— //
const btnToggleArcs = document.createElement('button');
btnToggleArcs.textContent='显示攻击范围';
Object.assign(btnToggleArcs.style,{
  position:'fixed',left:'12px',top:'50%',transform:'translateY(-50%)',
  padding:'8px 10px',border:'1px solid #666',background:'#1f1f1f',
  color:'#eaeaea',cursor:'pointer',zIndex:9999,borderRadius:'6px'
});
document.body.appendChild(btnToggleArcs);

// —— 常量/工具 —— //
const CELL=8;
const DIR_TO_RAD = [0, Math.PI/2, Math.PI, -Math.PI/2];
const GHOST_FADE_T = 0.25;
const GHOST_TIMEOUT = 1.0;
const MAX_SEND_PER_FRAME = 160;
const MAX_PROCESS_PER_FRAME = 400;

function deg2rad(d){ return d*Math.PI/180; }
function clamp(v,a,b){ return Math.max(a,Math.min(b,v)); }

let _lastFrameCostMs = 0;
let _skipDecor = false;

// —— 状态 —— //
let showArcs=false;
let mode='browse';
let selectedType=null;
let buildFacingDir=0;
let lastConfirmedDir=0;

let hoverX=-1, hoverY=-1;
let isMouseDown=false, selecting=false;
let selectStart=null, selectEnd=null;
let activePointerId=null;

// —— 服务器快照（只读） —— //
const S = {
  you: 0,
  W: 100, H: 100,
  gold: {1:0,2:0},
  core: { p1:1000, p2:1000 },
  map: new Uint8Array(100*100),
  hp:  new Uint16Array(100*100),
  owner: new Uint8Array(100*100),
  turrets: [],
  playersCount: 0,
  spectatorsCount: 0
};
function isSpectator(){ return S.you===0; }

// —— 本地子弹 —— //
const Local = { bullets: new Map(), arr: [] };

// —— 本地幽灵 —— //
const Ghost = {
  items: new Map(), placedKeySet: new Set(), queue: [], pendingSet: new Set(), cellQueue: []
};

// —— 背景离屏缓存 —— //
let bgCanvas=null, bgCtx=null, bgDirty=true;

// —— 简易音效 —— //
let AC=null;
function ac(){ if(!AC){ AC=new (window.AudioContext||window.webkitAudioContext)(); } return AC; }
function beep(freq=600, dur=0.06, vol=0.08){ try{ const a=ac(); const o=a.createOscillator(); const g=a.createGain(); o.type='square'; o.frequency.value=freq; g.gain.value=vol; o.connect(g); g.connect(a.destination); const t=a.currentTime; o.start(t); o.stop(t+dur);}catch{} }
function sfx_fire(){ beep(760,0.04,0.06); }

// —— 事件 —— //
btnToggleArcs.onclick = ()=>{
  showArcs=!showArcs;
  btnToggleArcs.textContent = showArcs?'隐藏攻击范围':'显示攻击范围';
};
function labelOf(t){
  return t==='road'?'道路':t==='wall'?'围墙':t==='turret'?'基础炮':t==='ciws'?'近防炮':t==='sniper'?'狙击炮':'';
}
function updateHUD(){
  goldEl.textContent = S.gold[S.you]||0;
  youEl.textContent = S.you===0 ? '你是：观战' : `你是：P${S.you}`;
  countsEl.textContent = `房间人数：${S.playersCount}/2，观战：${S.spectatorsCount}`;
}
function toast(msg,ms=1000){
  toastEl.textContent=msg;
  toastEl.hidden=false;
  clearTimeout(toastEl._t);
  toastEl._t=setTimeout(()=>toastEl.hidden=true,ms);
}
function setSpectatorUI(disabled){
  [...buildButtons, btnDemo, btnCancel].forEach(b=>{
    if(!b) return;
    b.disabled = !!disabled;
    if(disabled) b.title = '观战模式不可操作';
    else b.removeAttribute('title');
  });
}

// —— 模式 —— //
function enterBuildMode(type){
  if(isSpectator()){ toast('观战模式不可操作'); return; }
  mode='build'; selectedType=type;
  buildButtons.forEach(b=>b.classList.toggle('active', b.dataset.type===type));
  btnDemo?.classList.remove('active');
  buildFacingDir = (type==='ciws') ? 0 : lastConfirmedDir;
  modeLabel.textContent = `建造模式：${labelOf(type)}（R旋转，长按连续建造）`;
}
function enterDemolishMode(){
  if(isSpectator()){ toast('观战模式不可操作'); return; }
  mode='demolish'; selectedType=null;
  buildButtons.forEach(b=>b.classList.remove('active'));
  btnDemo?.classList.add('active');
  modeLabel.textContent='拆除模式：拖拽框选，松开后批量拆除（返还50%）';
}
function enterBrowseMode(){
  mode='browse'; selectedType=null;
  buildButtons.forEach(b=>b.classList.remove('active'));
  btnDemo?.classList.remove('active');
  modeLabel.textContent='浏览模式（F1 查看帮助）';
  selecting=false; selectStart=null; selectEnd=null;
}

function initUI(){
  btnRoad && (btnRoad.onclick   = ()=>enterBuildMode('road'));
  btnWall && (btnWall.onclick   = ()=>enterBuildMode('wall'));
  btnTurret && (btnTurret.onclick = ()=>enterBuildMode('turret'));
  btnCiws && (btnCiws.onclick   = ()=>enterBuildMode('ciws'));
  btnSniper && (btnSniper.onclick = ()=>enterBuildMode('sniper'));
  btnDemo && (btnDemo.onclick   = ()=>enterDemolishMode());
  btnCancel && (btnCancel.onclick = ()=>enterBrowseMode());

  window.addEventListener('keydown',(e)=>{
    const k=e.key.toLowerCase();
    if(isSpectator()){
      if(k==='d' || k==='1'||k==='2'||k==='3'||k==='4'||k==='5') toast('观战模式不可操作');
      return;
    }
    if(k==='1') enterBuildMode('road');
    else if(k==='2') enterBuildMode('wall');
    else if(k==='3') enterBuildMode('turret');
    else if(k==='4') enterBuildMode('ciws');
    else if(k==='5') enterBuildMode('sniper');
    else if(k==='d') enterDemolishMode();
    else if(e.key==='Escape'||e.key==='Esc') enterBrowseMode();
    else if(k==='r'){ if(mode==='build'&&selectedType){ buildFacingDir=(buildFacingDir+1)&3; } }
  });
}

// —— 坐标转换 —— //
function pointerToCell(e){
  const r=canvas.getBoundingClientRect();
  const px = e.clientX - r.left;
  const py = e.clientY - r.top;
  const mx = Math.floor(px / CELL);
  const my = Math.floor(py / CELL);
  return {px,py,mx,my};
}

// —— footprint & 取色 —— //
function getFootprint(type, dir){
  if(type==='turret') return {w:2,h:2};
  if(type==='ciws')   return (dir===0||dir===2)?{w:3,h:2}:{w:2,h:3};
  if(type==='sniper') return {w:4,h:4};
  if(type==='road'||type==='wall') return {w:1,h:1};
  return {w:1,h:1};
}
function colorForCell(v, owner, you){
  const ally = (owner===you);
  switch(v){
    case 1:  return COLOR.rock;
    case 2:  return COLOR.gold;
    case 3:
    case 4:  return ally ? COLOR.allyCore   : COLOR.enemyCore;
    case 10: return ally ? COLOR.allyRoad   : COLOR.enemyRoad;
    case 11: return ally ? COLOR.allyWall   : COLOR.enemyWall;
    case 12: return ally ? COLOR.allyTurret : COLOR.enemyTurret;
    case 13: return ally ? COLOR.allyCiws   : COLOR.enemyCiws;
    case 14: return ally ? COLOR.allySniper : COLOR.enemySniper;
    default: return null;
  }
}
function colorForType(type, ally){
  if(ally){
    if(type==='core')   return COLOR.allyCore;
    if(type==='road')   return COLOR.allyRoad;
    if(type==='wall')   return COLOR.allyWall;
    if(type==='turret') return COLOR.allyTurret;
    if(type==='ciws')   return COLOR.allyCiws;
    if(type==='sniper') return COLOR.allySniper;
  }else{
    if(type==='core')   return COLOR.enemyCore;
    if(type==='road')   return COLOR.enemyRoad;
    if(type==='wall')   return COLOR.enemyWall;
    if(type==='turret') return COLOR.enemyTurret;
    if(type==='ciws')   return COLOR.enemyCiws;
    if(type==='sniper') return COLOR.enemySniper;
  }
  return ally ? COLOR.ally : COLOR.enemy;
}

// —— 校验（客户端粗过滤） —— //
function inBounds(x,y){ return x>=0&&y>=0&&x<S.W&&y<S.H; }
function rectInBounds(x,y,w,h){ return x>=0&&y>=0&&(x+w)<=S.W&&(y+h)<=S.H; }
function areaEmptyClient(x,y,w,h){
  for(let j=0;j<h;j++) for(let i=0;i<w;i++){
    if(S.map[(y+j)*S.W+(x+i)]!==0) return false;
  }
  return true;
}
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

// —— Supercover —— //
function supercoverLineCells(x0,y0,x1,y1){
  const cells=[]; let dx=x1-x0, dy=y1-y0;
  const sx = Math.sign(dx)||1, sy = Math.sign(dy)||1;
  dx=Math.abs(dx); dy=Math.abs(dy);
  let x=x0, y=y0; cells.push({x,y});
  if(dx>=dy){
    let f=0;
    for(let i=0;i<dx;i++){
      x+=sx; f+=dy;
      if(f>=dx){ y+=sy; f-=dx; cells.push({x,y}); }
      cells.push({x,y});
    }
  }else{
    let f=0;
    for(let i=0;i<dy;i++){
      y+=sy; f+=dx;
      if(f>=dy){ x+=sx; f-=dy; cells.push({x,y}); }
      cells.push({x,y});
    }
  }
  const out=[]; const seen=new Set();
  for(const c of cells){ const k=c.x+'|'+c.y; if(!seen.has(k)){ seen.add(k); out.push(c);} }
  return out;
}

// —— 预构建箭头 Path2D —— //
const ARROW_PATHS = (() => {
  const mk = (rot90) => {
    const p = new Path2D();
    const pts = [{x:+0.5,y:0},{x:-0.5,y:-0.3},{x:-0.5,y:+0.3}];
    const sin = [0,1,0,-1][rot90], cos = [1,0,-1,0][rot90];
    const rx = (x,y)=>({ x: x*cos - y*sin, y: x*sin + y*cos });
    const a = rx(pts[0].x, pts[0].y), b = rx(pts[1].x, pts[1].y), c = rx(pts[2].x, pts[2].y);
    p.moveTo(a.x, a.y); p.lineTo(b.x, b.y); p.lineTo(c.x, c.y); p.closePath(); return p;
  };
  return [mk(0), mk(1), mk(2), mk(3)];
})();
function drawArrowFast(cx, cy, facingDir, size, color, alpha=1){
  const p = ARROW_PATHS[(facingDir|0)&3];
  const s = Math.max(size, 1);
  ctx.save(); ctx.translate(cx, cy); ctx.scale(s, s);
  ctx.globalAlpha = alpha; ctx.lineJoin='round'; ctx.lineCap='round';
  ctx.strokeStyle='rgba(0,0,0,0.95)'; ctx.lineWidth=Math.max(2.2, size*0.14)/s; ctx.stroke(p);
  ctx.fillStyle=color; ctx.fill(p);
  ctx.strokeStyle='rgba(255,255,255,0.75)'; ctx.lineWidth=Math.max(1.2, size*0.06)/s; ctx.stroke(p);
  ctx.restore();
}

// —— 幽灵 & 发送入队 —— //
function enqueueGhostAndSend(type, x, y, dir){
  const fp=getFootprint(type, dir);
  const key = `${x},${y},${fp.w}x${fp.h}`;
  if(Ghost.pendingSet.has(key)) return;
  if(!rectInBounds(x,y,fp.w,fp.h)) return;
  if(!areaEmptyClient(x,y,fp.w,fp.h)) return;
  if(!rectCanBuildHereClient(x,y,fp.w,fp.h)) return;
  Ghost.pendingSet.add(key);
  Ghost.queue.push({x,y,type,dir,key});
  Ghost.items.set(key, { x,y,w:fp.w,h:fp.h,type,dir,team:S.you,alpha:0.9,t0:performance.now(),status:'pending' });
}
function flushBuildQueue(){
  let quota = MAX_SEND_PER_FRAME;
  while(quota>0 && Ghost.queue.length){
    const it = Ghost.queue.shift(); quota--;
    Net.build(it.type, it.x, it.y, it.dir);
    const g = Ghost.items.get(it.key);
    if(g){ g.t0 = performance.now(); g.status='pending'; }
  }
}

// —— 指针事件 —— //
let lastDragCell = null;
function initPointer(){
  function handleMoveLike(e){
    const p = pointerToCell(e);
    hoverX=p.mx; hoverY=p.my;
    if(isMouseDown && activePointerId===e.pointerId){
      if(mode==='build' && selectedType && !isSpectator()){
        if(lastDragCell==null){ lastDragCell={x:p.mx,y:p.my}; Ghost.cellQueue.push({x:p.mx,y:p.my}); }
        else{
          const list = supercoverLineCells(lastDragCell.x,lastDragCell.y,p.mx,p.my);
          for(const c of list) Ghost.cellQueue.push(c);
          lastDragCell={x:p.mx,y:p.my};
        }
      }else if(mode==='demolish' && selecting && !isSpectator()){
        selectEnd={x:p.mx,y:p.my};
      }
    }
  }
  canvas.addEventListener('pointerrawupdate', handleMoveLike);
  canvas.addEventListener('pointermove', handleMoveLike);
  canvas.addEventListener('pointerdown',(e)=>{
    if(e.button!==0) return;
    activePointerId=e.pointerId; canvas.setPointerCapture(activePointerId);
    const p = pointerToCell(e); isMouseDown=true;
    if(isSpectator()) return;
    if(mode==='build'&&selectedType){
      Ghost.placedKeySet.clear(); lastDragCell={x:p.mx,y:p.my}; Ghost.cellQueue.push({x:p.mx,y:p.my});
    }else if(mode==='demolish'){
      selecting=true; selectStart={x:p.mx,y:p.my}; selectEnd={x:p.mx,y:p.my};
    }
  });
  function endPointer(e){
    if(e.pointerId!==activePointerId) return;
    isMouseDown=false; activePointerId=null; lastDragCell=null;
    if(!isSpectator() && mode==='demolish'&&selecting&&selectStart&&selectEnd){
      Net.demolish(selectStart.x,selectStart.y,selectEnd.x,selectEnd.y);
    }
    selecting=false; selectStart=null; selectEnd=null;
    try{ canvas.releasePointerCapture(e.pointerId); }catch{}
  }
  canvas.addEventListener('pointerup',endPointer);
  canvas.addEventListener('pointercancel',endPointer);
  canvas.addEventListener('contextmenu',(e)=>e.preventDefault());
}

// —— RAF 消费路径点 —— //
function consumeCellQueue(){
  let quota = MAX_PROCESS_PER_FRAME;
  while(quota>0 && Ghost.cellQueue.length){
    const c = Ghost.cellQueue.shift(); quota--;
    if(!inBounds(c.x,c.y)) continue;
    const fp=getFootprint(selectedType||'road', buildFacingDir);
    const k=`${c.x},${c.y},${fp.w}x${fp.h}`;
    if(Ghost.placedKeySet.has(k)) continue;
    Ghost.placedKeySet.add(k);
    if(mode==='build' && selectedType && !isSpectator()){
      enqueueGhostAndSend(selectedType, c.x, c.y, buildFacingDir);
      lastConfirmedDir = buildFacingDir;
    }
  }
}

// —— 联机（单房间：自动加入） —— //
function connectAuto(){
  Net.onRoom = (m)=>{
    if(typeof m.playersCount==='number') S.playersCount=m.playersCount;
    else S.playersCount = (m.players||[]).filter(p=>p && p.name).length;
    S.spectatorsCount = m.spectatorsCount||0;
    updateHUD();
  };
  Net.onStart = (m)=>{
    S.you = m.you; S.W=m.W; S.H=m.H;
    canvas.width  = S.W*CELL; canvas.height = S.H*CELL;
    bgDirty = true;
    updateHUD();
    setSpectatorUI(isSpectator());
  };
  Net.onState = (m)=>{
    const hadBullets = Local.bullets.size;
    if(typeof m.playersCount==='number') S.playersCount=m.playersCount;
    if(typeof m.spectatorsCount==='number') S.spectatorsCount=m.spectatorsCount;

    S.gold   = m.gold;
    S.core   = m.core;
    S.map    = new Uint8Array(m.map);
    S.hp     = new Uint16Array(m.hp);
    S.owner  = new Uint8Array(m.owner);
    S.turrets= m.turrets;
    bgDirty = true;

    reconcileBulletsFromServer(m.bullets);
    if(Local.bullets.size > hadBullets) sfx_fire();

    updateHUD();
    reconcileGhostsWithServer();
  };
  Net.onEnded = (m)=>{ toast(m.winner===S.you?'你获胜':'你失败', 3000); };
  Net.onError = (e)=>{ alert('联机错误：'+(e.code||'UNKNOWN')); };

  Net.connect({ name: 'Relice' });
  setTimeout(()=>Net.ready(true), 300);
}

function reconcileGhostsWithServer(){
  const now = performance.now();
  for(const [key,g] of Ghost.items){
    let ok = true;
    for(let j=0;j<g.h;j++){
      for(let i=0;i<g.w;i++){
        const idx = (g.y+j)*S.W + (g.x+i);
        const v = S.map[idx], o = S.owner[idx];
        let expectV = 0;
        if(g.type==='core')   expectV = (S.you===1)?3:4;
        if(g.type==='road')   expectV = 10;
        if(g.type==='wall')   expectV = 11;
        if(g.type==='turret') expectV = 12;
        if(g.type==='ciws')   expectV = 13;
        if(g.type==='sniper') expectV = 14;
        if(v!==expectV || o!==S.you){ ok=false; break; }
      }
      if(!ok) break;
    }
    if(ok){
      Ghost.items.delete(key); Ghost.pendingSet.delete(key);
    }else{
      if((now - g.t0)/1000 > GHOST_TIMEOUT && g.status==='pending'){
        g.status='rejected'; g.alpha=0.9;
      }
    }
  }
}

// —— 子弹融合（瞬时消失 + 数组视图） —— //
function reconcileBulletsFromServer(serverList){
  const seen = new Set();
  for(const sb of serverList){
    seen.add(sb.id);
    const lb = Local.bullets.get(sb.id);
    if(!lb){
      Local.bullets.set(sb.id, { x:sb.x, y:sb.y, vx:sb.vx, vy:sb.vy, team:sb.team, dead:false });
    }else{
      const blend = 0.2;
      lb.x += (sb.x - lb.x) * blend;
      lb.y += (sb.y - lb.y) * blend;
      lb.vx = sb.vx; lb.vy = sb.vy; lb.team = sb.team; lb.dead=false;
    }
  }
  for(const [id] of Local.bullets){
    if(!seen.has(id)) Local.bullets.delete(id);
  }
  Local.arr = Array.from(Local.bullets.values());
}

function updateLocal(dt){
  for(const [id, b] of Local.bullets){
    if(b.dead){ Local.bullets.delete(id); continue; }
    b.x += b.vx * dt; b.y += b.vy * dt;
  }
  const _toDel = [];
  for(const [key,g] of Ghost.items){
    if(g.status==='rejected'){
      g.alpha -= dt / GHOST_FADE_T;
      if(g.alpha<=0) _toDel.push(key);
    }
  }
  for(const k of _toDel){ Ghost.items.delete(k); Ghost.pendingSet.delete(k); }
}

// —— 背景缓存 —— //
function ensureBG(){
  if(!bgCanvas || bgCanvas.width!==canvas.width || bgCanvas.height!==canvas.height){
    bgCanvas = document.createElement('canvas');
    bgCanvas.width = canvas.width;
    bgCanvas.height = canvas.height;
    bgCtx = bgCanvas.getContext('2d');
    bgDirty = true;
  }
  if(!bgDirty) return;

  const W=S.W, H=S.H;
  for(let y=0;y<H;y++) for(let x=0;x<W;x++){
    bgCtx.fillStyle=((x+y)&1)?COLOR.gridA:COLOR.gridB;
    bgCtx.fillRect(x*CELL,y*CELL,CELL,CELL);
  }
  for(let y=0;y<H;y++) for(let x=0;x<W;x++){
    const idx=y*W+x; const v=S.map[idx]; if(!v) continue;
    const o=S.owner[idx];
    const fill=colorForCell(v, o, S.you); if(!fill) continue;
    bgCtx.fillStyle = fill;
    bgCtx.fillRect(x*CELL,y*CELL,CELL,CELL);
    if(v===1 || v===2){
      bgCtx.lineWidth = 0.75;
      bgCtx.strokeStyle = COLOR.resStroke;
      bgCtx.strokeRect(x*CELL+0.35, y*CELL+0.35, CELL-0.7, CELL-0.7);
    }
  }
  bgDirty = false;
}

// —— 幽灵绘制（批量填充） —— //
function drawGhosts(){
  const groups = new Map();
  const add = (k, color, x,y,w,h, alpha)=> {
    let g = groups.get(k);
    if(!g){ g = { path: new Path2D(), color, alphaSum:0, count:0 }; groups.set(k, g); }
    g.path.rect(x*CELL, y*CELL, w*CELL, h*CELL); g.alphaSum += alpha; g.count++;
  };
  for(const g of Ghost.items.values()){
    const ally = (g.team===S.you);
    const key = g.type + '-' + (ally?'a':'e');
    const fill = colorForType(g.type, ally);
    const alpha = clamp(g.alpha, 0, 0.9)*0.7;
    if(alpha<=0) continue;
    add(key, fill, g.x,g.y,g.w,g.h, alpha);
  }
  for(const {path, color, alphaSum, count} of groups.values()){
    ctx.save(); ctx.globalAlpha = (count? alphaSum/count : 0.5); ctx.fillStyle = color; ctx.fill(path); ctx.restore();
  }

  if(_skipDecor) return;
  for(const g of Ghost.items.values()){
    const ally = (g.team===S.you);
    const arc=(g.type==='turret')?90:(g.type==='ciws')?180:(g.type==='sniper')?45:(g.type==='core')?360:0;
    const range=(g.type==='turret')?8:(g.type==='ciws')?3:(g.type==='sniper')?20:(g.type==='core')?16:0;
    if(arc<=0) continue;
    const cenDir = (g.type==='ciws') ? ((g.dir+1)&3) : g.dir;
    const cx=(g.x+g.w*0.5)*CELL, cy=(g.y+g.h*0.5)*CELL, r=range*CELL;

    ctx.save(); ctx.globalAlpha=0.16; ctx.fillStyle = ally?COLOR.allyLight:COLOR.enemyLight;
    if(arc<360){
      const center=DIR_TO_RAD[cenDir|0];
      ctx.beginPath(); const a0=center-deg2rad(arc)/2, a1=center+deg2rad(arc)/2;
      ctx.moveTo(cx,cy); ctx.arc(cx,cy,r,a0,a1); ctx.closePath(); ctx.fill();
    }else{
      ctx.beginPath(); ctx.arc(cx,cy,r,0,Math.PI*2); ctx.closePath(); ctx.fill();
    }
    ctx.restore();

    if(g.type!=='core'){
      const color = ally?COLOR.ally:COLOR.enemy;
      drawArrowFast(cx, cy, cenDir, Math.min(g.w,g.h)*CELL*0.9, color, 0.9);
    }
  }
}

// —— 主绘制 —— //
function draw(){
  ensureBG();
  ctx.drawImage(bgCanvas, 0, 0);

  if(showArcs && !_skipDecor){
    for(const t of S.turrets){
      const r=t.rangeCells*CELL;
      const colorFill=(t.team===S.you)?COLOR.allyLight:COLOR.enemyLight;
      if(t.arcDeg<360){
        const center=DIR_TO_RAD[t.facingDir|0];
        ctx.save(); ctx.globalAlpha=0.15; ctx.fillStyle=colorFill;
        ctx.beginPath();
        const a0=center-deg2rad(t.arcDeg)/2, a1=center+deg2rad(t.arcDeg)/2;
        ctx.moveTo(t.cx*CELL,t.cy*CELL);
        ctx.arc(t.cx*CELL,t.cy*CELL,r,a0,a1);
        ctx.closePath(); ctx.fill(); ctx.restore();
      }else{
        ctx.save(); ctx.globalAlpha=0.15; ctx.fillStyle=colorFill;
        ctx.beginPath(); ctx.arc(t.cx*CELL,t.cy*CELL,r,0,Math.PI*2); ctx.closePath(); ctx.fill(); ctx.restore();
      }
    }
  }

  if(!_skipDecor){
    for(const t of S.turrets){
      if(t.role==='core') continue;
      const color = (t.team===S.you)?COLOR.ally:COLOR.enemy;
      drawArrowFast(t.cx*CELL, t.cy*CELL, t.facingDir, Math.min(t.w,t.h)*CELL*0.9, color, 0.95);
    }
  }

  drawGhosts();

  // 子弹批量绘制 + 降采样
  const n = Local.arr.length;
  const step = (n > 1200) ? 3 : (n > 700) ? 2 : 1;
  ctx.fillStyle = '#ffffff'; ctx.beginPath();
  for (let i=0;i<n;i+=step){ const b = Local.arr[i]; if(b.team===S.you) ctx.rect(b.x*CELL-2, b.y*CELL-2, 4, 4); }
  ctx.fill();
  ctx.fillStyle = '#ffd1d1'; ctx.beginPath();
  for (let i=0;i<n;i+=step){ const b = Local.arr[i]; if(b.team!==S.you) ctx.rect(b.x*CELL-2, b.y*CELL-2, 4, 4); }
  ctx.fill();

  // 建造预览框
  if(!isSpectator() && mode==='build'&&selectedType&&hoverX>=0&&hoverY>=0){
    const fp=getFootprint(selectedType, buildFacingDir);
    const ok=rectInBounds(hoverX,hoverY,fp.w,fp.h)&&areaEmptyClient(hoverX,hoverY,fp.w,fp.h)&&rectCanBuildHereClient(hoverX,hoverY,fp.w,fp.h);
    ctx.globalAlpha=0.35; ctx.fillStyle=ok?COLOR.ally:COLOR.enemy;
    ctx.fillRect(hoverX*CELL,hoverY*CELL,fp.w*CELL,fp.h*CELL); ctx.globalAlpha=1;
    ctx.lineWidth=1; ctx.strokeStyle=ok?COLOR.allyLight:COLOR.enemyLight;
    ctx.strokeRect(hoverX*CELL+0.5,hoverY*CELL+0.5,fp.w*CELL-1,fp.h*CELL-1);

    if(!_skipDecor){
      const arc=(selectedType==='turret')?90:(selectedType==='ciws')?180:(selectedType==='sniper')?45:(selectedType==='core')?360:0;
      const range=(selectedType==='turret')?8:(selectedType==='ciws')?3:(selectedType==='sniper')?20:(selectedType==='core')?16:0;
      if(arc>0){
        const cx=(hoverX+fp.w*0.5)*CELL, cy=(hoverY*CELL)+(fp.h*CELL*0.5);
        const cenDir = (selectedType==='ciws') ? ((buildFacingDir+1)&3) : buildFacingDir;
        const center=DIR_TO_RAD[cenDir|0]; const r=range*CELL;
        if(arc<360){
          ctx.save(); ctx.globalAlpha=0.22; ctx.fillStyle=ok?COLOR.ally:COLOR.enemy;
          ctx.beginPath(); const a0=center-deg2rad(arc)/2, a1=center+deg2rad(arc)/2;
          ctx.moveTo(cx,cy); ctx.arc(cx,cy,r,a0,a1); ctx.closePath(); ctx.fill(); ctx.restore();
        }else{
          ctx.save(); ctx.globalAlpha=0.22; ctx.fillStyle=ok?COLOR.ally:COLOR.enemy;
          ctx.beginPath(); ctx.arc(cx,cy,r,0,Math.PI*2); ctx.closePath(); ctx.fill(); ctx.restore();
        }
        if(selectedType!=='core'){
          const colorPreview = ok ? COLOR.ally : COLOR.enemy;
          drawArrowFast(cx, cy, cenDir, Math.min(fp.w,fp.h)*CELL*0.9, colorPreview, 0.95);
        }
      }
    }
  }else if(!isSpectator() && mode==='demolish'&&selecting&&selectStart&&selectEnd){
    const x0=Math.min(selectStart.x,selectEnd.x)*CELL;
    const x1=(Math.max(selectStart.x,selectEnd.x)+1)*CELL;
    const y0=Math.min(selectStart.y,selectEnd.y)*CELL;
    const y1=(Math.max(selectStart.y,selectEnd.y)+1)*CELL;
    const w=x1-x0, h=y1-y0;
    ctx.globalAlpha=0.25; ctx.fillStyle=COLOR.enemy; ctx.fillRect(x0,y0,w,h); ctx.globalAlpha=1;
    ctx.lineWidth=2; ctx.setLineDash([6,4]); ctx.strokeStyle=COLOR.enemyLight;
    ctx.strokeRect(x0+1,y0+1,w-2,h-2); ctx.setLineDash([]);
  }
}

// —— 帧循环 —— //
let _rafLast = performance.now();
function loop(ts){
  const t0 = performance.now();
  const dt = Math.min(0.05, (ts - _rafLast)/1000);
  _rafLast = ts;

  consumeCellQueue();
  flushBuildQueue();

  updateLocal(dt);
  draw();

  const used = performance.now() - t0;
  _lastFrameCostMs = used;
  _skipDecor = used > 18;

  requestAnimationFrame(loop);
}

// —— 启动 —— //
function initAll(){
  initUI();
  initPointer();
  updateHUD();
  connectAuto(); // 自动接入单房间
  requestAnimationFrame(loop);
}
initAll();

// —— Net 传输层（同源 WS） —— //
(function(){
  if (window.Net) return;
  const Net = {};
  let ws=null;

  Net.onRoom = ()=>{};
  Net.onStart= ()=>{};
  Net.onState= ()=>{};
  Net.onEnded= ()=>{};
  Net.onError= (e)=>{ console.error(e); };

  Net.connect = function({name='Relice'}={}){
    ws = new WebSocket(WS_URL);
    ws.onopen = ()=> { ws.send(JSON.stringify({type:'join', name})); };
    ws.onmessage = (ev)=>{
      let m; try{ m=JSON.parse(ev.data);}catch{ return; }
      switch(m.type){
        case 'room':  Net.onRoom(m); break;
        case 'start': Net.onStart(m); break;
        case 'state': Net.onState(m); break;
        case 'ended': Net.onEnded(m); break;
        default: break;
      }
    };
    ws.onerror = (e)=> Net.onError(e);
    ws.onclose = ()=>{};
    Net._ws = ws;
  };
  Net.ready = function(flag){ ws && ws.send(JSON.stringify({type:'ready', ready: !!flag})); };
  Net.build = function(kind,x,y,dir){ ws && ws.send(JSON.stringify({type:'build', kind, x, y, dir})); };
  Net.demolish = function(x0,y0,x1,y1){ ws && ws.send(JSON.stringify({type:'demolish', x0,y0,x1,y1})); };

  window.Net = Net;
})();
