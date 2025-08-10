// server.js — 单房间：静态托管 + 同端口 WebSocket + 地图生成 + 对战逻辑 + 刷新投票
// 广播节流：逻辑 20fps，状态广播 5fps；事件仍即时广播
// 子弹碰撞：DDA 逐格扫描，阻挡石头/金子/敌方建筑
// 结束后 5 秒自动刷新地图并重开一局

const path = require('path');
const http = require('http');
const express = require('express');
const WebSocket = require('ws');

const app = express();
app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (_, res) => res.type('text').send('ok'));

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

/* -------------------- 常量与工具 -------------------- */
const W = 100, H = 100;             // 地图尺寸
const TICK_MS = 50;                 // 逻辑帧率 20fps
const BROADCAST_MS = 200;           // 状态广播 5fps（节流）
const START_GOLD = 5000;            // 初始金币
const VOTE_MS = 20000;              // 刷新投票超时 20s

const ID_EMPTY=0, ID_ROCK=1, ID_GOLD=2, ID_CORE_P1=3, ID_CORE_P2=4,
      ID_ROAD=10, ID_WALL=11, ID_TURRET=12, ID_CIWS=13, ID_SNIPER=14;

const HP = {
  [ID_ROCK]: 50,
  [ID_GOLD]: 150,
  [ID_ROAD]: 50,
  [ID_WALL]: 250,
  [ID_TURRET]: 50,
  [ID_CIWS]: 100,
  [ID_SNIPER]: 25,
  core: 1000
};
const COST = { road:10, wall:30, turret:100, ciws:120, sniper:200, core:2000 };
const REWARD_GOLD = 1000;

const dist2 = (ax,ay,bx,by)=> (ax-bx)*(ax-bx)+(ay-by)*(ay-by);

/* -------------------- 单房间结构 -------------------- */
function newRoom(){
  const room = {
    id: 'GLOBAL',
    players: {1:null, 2:null},      // {id, name, ws}
    spectators: new Set(),          // 观战者 ws 集合
    started: false,
    // 世界状态
    W, H,
    map: new Uint8Array(W*H),
    hp:  new Uint16Array(W*H),
    owner: new Uint8Array(W*H),
    gold: {1:START_GOLD, 2:START_GOLD},
    coreHP: {p1:HP.core, p2:HP.core},
    turrets: [],                    // {id, role, team, x,y,w,h, cx,cy, facingDir, arcDeg, rangeCells, fireRate, bulletHP, bulletSpeed, scatterDeg, cd}
    bullets: [],                    // {id,x,y,vx,vy,team,life}
    bulletSeq: 1,
    pendingRefresh: null,           // {initiator:1|2, deadline:number}
    timer: null,
    _lastBroadcast: 0               // 广播节流
  };
  genMap(room);
  return room;
}
const room = newRoom();

/* -------------------- 地图与核心 -------------------- */
function setCell(room, x,y, id, hp, owner=0){
  if(x<0||y<0||x>=W||y>=H) return;
  const i = y*W+x;
  room.map[i]=id; room.hp[i]=hp||0; room.owner[i]=owner;
}
function areaClear(room,x,y,w,h){
  for(let j=0;j<h;j++) for(let i=0;i<w;i++){
    setCell(room, x+i, y+j, ID_EMPTY, 0, 0);
  }
}
function placeCore(room, team, cx, cy){
  const x = cx-1, y = cy-1, id = (team===1)?ID_CORE_P1:ID_CORE_P2;
  for(let j=0;j<3;j++) for(let i=0;i<3;i++){
    setCell(room, x+i, y+j, id, HP.core, team);
  }
  // 核心炮台（保持 16 格）
  room.turrets.push({
    id: 'core-'+team,
    role: 'core',
    team,
    x, y, w:3, h:3,
    cx: cx+0.0, cy: cy+0.0,
    facingDir: 0,
    arcDeg: 360,
    rangeCells: 16,
    fireRate: 2,
    bulletHP: 100,
    bulletSpeed: 24,
    scatterDeg: 4,
    cd: 0
  });
}
function genMap(room){
  const {map,hp,owner} = room;
  map.fill(0); hp.fill(0); owner.fill(0);

  // 石头：~40% 随机撒点
  for(let y=0;y<H;y++){
    for(let x=0;x<W;x++){
      if(Math.random()<0.40){
        setCell(room,x,y,ID_ROCK,HP[ID_ROCK],0);
      }
    }
  }
  // 金子：低频聚类（概率下调）
  const clusters = 32;
  for(let k=0;k<clusters;k++){
    const cx = 4+Math.floor(Math.random()*(W-8));
    const cy = 4+Math.floor(Math.random()*(H-8));
    const r  = 3+Math.floor(Math.random()*3);
    for(let y=cy-r;y<=cy+r;y++){
      for(let x=cx-r;x<=cx+r;x++){
        if(x<0||y<0||x>=W||y>=H) continue;
        const d2=(x-cx)*(x-cx)+(y-cy)*(y-cy);
        if(d2<=r*r && Math.random()<0.25){
          setCell(room,x,y,ID_GOLD,HP[ID_GOLD],0);
        }
      }
    }
  }

  // 核心放置
  const valid = (cx,cy)=> cx>=2 && cy>=2 && cx<=W-3 && cy<=H-3;
  let p1=null, p2=null, tries=0;
  while(tries++<500){
    const a = {cx:2+Math.floor(Math.random()*(W-4)), cy:2+Math.floor(Math.random()*(H-4))};
    const b = {cx:2+Math.floor(Math.random()*(W-4)), cy:2+Math.floor(Math.random()*(H-4))};
    if(!valid(a.cx,a.cy) || !valid(b.cx,b.cy)) continue;
    const d = Math.sqrt(dist2(a.cx,a.cy,b.cx,b.cy));
    if(d>=30 && d<=80){ p1=a; p2=b; break; }
  }
  if(!p1){ p1={cx:10,cy:10}; }
  if(!p2){ p2={cx:W-11,cy:H-11}; }
  areaClear(room, p1.cx-1, p1.cy-1, 3,3);
  areaClear(room, p2.cx-1, p2.cy-1, 3,3);
  placeCore(room, 1, p1.cx, p1.cy);
  placeCore(room, 2, p2.cx, p2.cy);

  // 剩余空地全部填石头
  for(let y=0;y<H;y++){
    for(let x=0;x<W;x++){
      const i = y*W + x;
      if(map[i] === ID_EMPTY){
        setCell(room, x, y, ID_ROCK, HP[ID_ROCK], 0);
      }
    }
  }
}

/* -------------------- 建造/拆除 -------------------- */
function footprint(kind, dir){
  if(kind==='turret') return {w:2,h:2};
  if(kind==='ciws')   return (dir===0||dir===2)?{w:3,h:2}:{w:2,h:3};
  if(kind==='sniper') return {w:4,h:4};
  if(kind==='road'||kind==='wall') return {w:1,h:1};
  return {w:1,h:1};
}
function rectEmpty(room,x,y,w,h){
  if(x<0||y<0||x+w>W||y+h>H) return false;
  for(let j=0;j<h;j++) for(let i=0;i<w;i++){
    if(room.map[(y+j)*W+(x+i)]!==ID_EMPTY) return false;
  }
  return true;
}
function rectAdjToOwn(room,team,x,y,w,h){
  const xmin=Math.max(0,x-1), xmax=Math.min(W-1,x+w);
  const ymin=Math.max(0,y-1), ymax=Math.min(H-1,y+h);
  for(let yy=ymin;yy<=ymax;yy++){
    for(let xx=xmin;xx<=xmax;xx++){
      const onPerimeter=(xx<x||xx>=x+w||yy<y||yy>=y+h);
      if(!onPerimeter) continue;
      const i=yy*W+xx, v=room.map[i], o=room.owner[i];
      const isBuilding = (v===ID_CORE_P1||v===ID_CORE_P2||v===ID_ROAD||v===ID_WALL||v===ID_TURRET||v===ID_CIWS||v===ID_SNIPER);
      if(isBuilding && o===team) return true;
    }
  }
  return false;
}
function spend(room, team, cost){ if(room.gold[team]>=cost){ room.gold[team]-=cost; return true; } return false; }

function addTurret(room, kind, team, x,y,dir){
  const fp = footprint(kind,dir);
  const cx = x + fp.w/2, cy = y + fp.h/2;
  if(kind==='turret'){
    room.turrets.push({ id:'t'+Date.now()+Math.random(), role:'turret', team,
      x,y,w:fp.w,h:fp.h, cx,cy, facingDir:dir, arcDeg:90, rangeCells:16, fireRate:1, bulletHP:50, bulletSpeed:22, scatterDeg:2, cd:0 });
  }else if(kind==='ciws'){
    const cenDir = (dir+1)&3;
    room.turrets.push({ id:'c'+Date.now()+Math.random(), role:'ciws', team,
      x,y,w:fp.w,h:fp.h, cx,cy, facingDir:cenDir, arcDeg:180, rangeCells:6, fireRate:10, bulletHP:50, bulletSpeed:28, scatterDeg:1, cd:0 });
  }else if(kind==='sniper'){
    room.turrets.push({ id:'s'+Date.now()+Math.random(), role:'sniper', team,
      x,y,w:fp.w,h:fp.h, cx,cy, facingDir:dir, arcDeg:45, rangeCells:40, fireRate:0.2, bulletHP:500, bulletSpeed:36, scatterDeg:0, cd:0 });
  }
}

function buildAt(room, team, kind, x,y,dir){
  const fp = footprint(kind,dir);
  if(!rectEmpty(room,x,y,fp.w,fp.h)) return false;
  if(!rectAdjToOwn(room,team,x,y,fp.w,fp.h)) return false;

  const cost = COST[kind]||0;
  if(!spend(room,team,cost)) return false;

  let id=ID_EMPTY, hp=0;
  if(kind==='road'){ id=ID_ROAD; hp=HP[ID_ROAD]; }
  else if(kind==='wall'){ id=ID_WALL; hp=HP[ID_WALL]; }
  else if(kind==='turret'){ id=ID_TURRET; hp=HP[ID_TURRET]; }
  else if(kind==='ciws'){ id=ID_CIWS; hp=HP[ID_CIWS]; }
  else if(kind==='sniper'){ id=ID_SNIPER; hp=HP[ID_SNIPER]; }

  for(let j=0;j<fp.h;j++) for(let i=0;i<fp.w;i++){
    setCell(room, x+i, y+j, id, hp, team);
  }
  if(id===ID_TURRET||id===ID_CIWS||id===ID_SNIPER){
    addTurret(room, kind, team, x,y,dir);
  }
  return true;
}

function demolishRect(room, team, x0,y0,x1,y1){
  const xmin=Math.max(0, Math.min(x0,x1));
  const xmax=Math.min(W-1, Math.max(x0,x1));
  const ymin=Math.max(0, Math.min(y0,y1));
  const ymax=Math.min(H-1, Math.max(y0,y1));
  let refund=0;

  for(let y=ymin;y<=ymax;y++){
    for(let x=xmin;x<=xmax;x++){
      const i=y*W+x, v=room.map[i], o=room.owner[i];
      if(o!==team) continue;
      if(v===ID_ROAD){ refund += COST.road*0.5; setCell(room,x,y,ID_EMPTY,0,0); }
      else if(v===ID_WALL){ refund += COST.wall*0.5; setCell(room,x,y,ID_EMPTY,0,0); }
      else if(v===ID_TURRET){ refund += COST.turret*0.5; setCell(room,x,y,ID_EMPTY,0,0); removeTurretAt(room,x,y); }
      else if(v===ID_CIWS){ refund += COST.ciws*0.5; setCell(room,x,y,ID_EMPTY,0,0); removeTurretAt(room,x,y); }
      else if(v===ID_SNIPER){ refund += COST.sniper*0.5; setCell(room,x,y,ID_EMPTY,0,0); removeTurretAt(room,x,y); }
    }
  }
  room.gold[team]+=Math.floor(refund);
}
function removeTurretAt(room,x,y){
  room.turrets = room.turrets.filter(t=> !(x>=t.x && y>=t.y && x<t.x+t.w && y<t.y+t.h) );
}

/* -------------------- 射击与子弹（含 DDA 碰撞） -------------------- */
function withinArc(tx,ty, t){
  const dx = tx - t.cx, dy = ty - t.cy;
  if(dx*dx + dy*dy > t.rangeCells*t.rangeCells) return false;
  if(t.arcDeg>=360) return true;
  const ang = Math.atan2(dy,dx);
  const centers = [0, Math.PI/2, Math.PI, -Math.PI/2];
  const center = centers[t.facingDir|0];
  let d = Math.atan2(Math.sin(ang-center), Math.cos(ang-center));
  const half = (t.arcDeg*Math.PI/180)/2;
  return Math.abs(d) <= half + 1e-6;
}
function tryShoot(room, t, dt){
  t.cd -= dt;
  if(t.cd>0) return;

  const prio = (id)=> (id===ID_TURRET||id===ID_CIWS||id===ID_SNIPER)?5
                     : (id===ID_CORE_P1||id===ID_CORE_P2)?4
                     : (id===ID_WALL||id===ID_ROAD)?3
                     : (id===ID_GOLD)?2
                     : (id===ID_ROCK)?1 : 0;

  let best=null, bestScore=-1, bestDist=1e9;
  const x0=Math.max(0, Math.floor(t.cx - t.rangeCells));
  const y0=Math.max(0, Math.floor(t.cy - t.rangeCells));
  const x1=Math.min(W-1, Math.ceil(t.cx + t.rangeCells));
  const y1=Math.min(H-1, Math.ceil(t.cy + t.rangeCells));

  for(let y=y0;y<=y1;y++){
    for(let x=x0;x<=x1;x++){
      const i=y*W+x, id=room.map[i]; if(id===ID_EMPTY) continue;
      const o=room.owner[i];
      if(o===t.team && (id===ID_TURRET||id===ID_CIWS||id===ID_SNIPER||id===ID_WALL||id===ID_ROAD||id===ID_CORE_P1||id===ID_CORE_P2)) continue;
      if(!withinArc(x+0.5,y+0.5,t)) continue;
      const s = prio(id); if(s===0) continue;
      const d2v = dist2(t.cx,t.cy, x+0.5,y+0.5);
      if(s>bestScore || (s===bestScore && d2v<bestDist)){
        best = {x:x+0.5, y:y+0.5}; bestScore=s; bestDist=d2v;
      }
    }
  }

  if(best){
    const ang = Math.atan2(best.y - t.cy, best.x - t.cx);
    const scatter = (t.scatterDeg||0) * (Math.PI/180);
    const jitter = (scatter>0)? ( (Math.random()*2-1) * scatter ) : 0;
    const a = ang + jitter;
    const speed = t.bulletSpeed || 24;
    const vx = Math.cos(a)*speed;
    const vy = Math.sin(a)*speed;
    const id = room.bulletSeq++;
    room.bullets.push({ id, x:t.cx, y:t.cy, vx, vy, team:t.team, life:t.rangeCells/speed });
    t.cd = 1/(t.fireRate||1);
  }
}

/* === DDA 扫描首个命中格 === */
function sweepHitCell(room, x0, y0, x1, y1, team) {
  const W = room.W, H = room.H;

  let cx = Math.floor(x0), cy = Math.floor(y0);
  const dx = x1 - x0, dy = y1 - y0;

  const stepX = dx > 0 ? 1 : (dx < 0 ? -1 : 0);
  const stepY = dy > 0 ? 1 : (dy < 0 ? -1 : 0);

  const invDx = dx !== 0 ? 1 / Math.abs(dx) : Infinity;
  const invDy = dy !== 0 ? 1 / Math.abs(dy) : Infinity;

  let tMaxX =
    dx > 0 ? ((cx + 1) - x0) * invDx :
    dx < 0 ? (x0 - cx) * invDx : Infinity;
  let tMaxY =
    dy > 0 ? ((cy + 1) - y0) * invDy :
    dy < 0 ? (y0 - cy) * invDy : Infinity;

  const tDeltaX = invDx;
  const tDeltaY = invDy;

  while (true) {
    if (tMaxX < tMaxY) {
      cx += stepX;
      if (tMaxX > 1) return null;
      tMaxX += tDeltaX;
    } else {
      cy += stepY;
      if (tMaxY > 1) return null;
      tMaxY += tDeltaY;
    }

    if (cx < 0 || cy < 0 || cx >= W || cy >= H) return null;

    const i = cy * W + cx;
    const v = room.map[i];
    if (v !== ID_EMPTY) {
      if (room.owner[i] !== team) {
        return { cx, cy, i, v };
      }
    }
  }
}

/* === 子弹步进，使用 DDA 扫描路径 === */
function stepBullets(room, dt){
  const { map, hp, owner } = room;

  for (let b of room.bullets) {
    b.life -= dt;
    if (b.life <= 0) { b.dead = true; continue; }

    const nx = b.x + b.vx * dt;
    const ny = b.y + b.vy * dt;

    const hit = sweepHitCell(room, b.x, b.y, nx, ny, b.team);
    if (hit) {
      const i = hit.i;
      const v = map[i];

      const damage = Math.min(9999, hp[i]);
      hp[i] -= damage;

      if (hp[i] <= 0) {
        if (v === ID_GOLD) {
          room.gold[b.team] += REWARD_GOLD;
        }
        if (v === ID_TURRET || v === ID_CIWS || v === ID_SNIPER) {
          removeTurretAt(room, hit.cx, hit.cy);
        }
        map[i] = ID_EMPTY; hp[i] = 0; owner[i] = 0;
      }

      b.dead = true;
      continue;
    }

    b.x = nx; b.y = ny;
  }

  room.bullets = room.bullets.filter(b => !b.dead);
}

/* -------------------- 游戏循环与广播 -------------------- */
function startGame(room){
  if(room.timer) return;
  room.started = true;
  room._lastBroadcast = 0;
  room.timer = setInterval(()=>{
    const now = Date.now();

    // 逻辑
    stepTurrets(room, TICK_MS/1000);
    stepBullets(room, TICK_MS/1000);
    if(room.pendingRefresh && now>room.pendingRefresh.deadline){
      const from = room.pendingRefresh.initiator;
      room.pendingRefresh = null;
      broadcast(room, {type:'refresh_result', ok:false, reason:'timeout', from});
    }
    checkWin(room);

    // 广播节流
    if (now - room._lastBroadcast >= BROADCAST_MS) {
      room._lastBroadcast = now;
      broadcastState(room);
    }
  }, TICK_MS);
}
function stopGame(room){
  if(room.timer){ clearInterval(room.timer); room.timer=null; }
  room.started=false;
}
function stepTurrets(room, dt){
  for(const t of room.turrets){ tryShoot(room, t, dt); }
}
function checkWin(room){
  let hasP1=false, hasP2=false;
  for(let i=0;i<room.map.length;i++){
    if(room.map[i]===ID_CORE_P1) hasP1=true;
    if(room.map[i]===ID_CORE_P2) hasP2=true;
    if(hasP1&&hasP2) break;
  }
  if(!hasP1 || !hasP2){
    const winner = hasP1 ? 1 : hasP2 ? 2 : 0;
    broadcast(room, {type:'ended', winner});
    stopGame(room);

    // 5 秒后自动刷新地图并重启一局
    setTimeout(() => {
      resetRoom(room);
      startGame(room);
      broadcastState(room);
    }, 5000);
  }
}
function broadcast(room, msg){
  for(const pid of [1,2]){
    const p = room.players[pid];
    if(p && p.ws.readyState===WebSocket.OPEN){
      p.ws.send(JSON.stringify(msg));
    }
  }
  for(const ws of room.spectators){
    if(ws.readyState===WebSocket.OPEN){
      ws.send(JSON.stringify(msg));
    }
  }
}
function statePayload(room){
  // 压缩子弹数值精度，减少 JSON 体积
  const bullets = room.bullets.map(b=>({
    id:b.id,
    x:+b.x.toFixed(3),
    y:+b.y.toFixed(3),
    vx:+b.vx.toFixed(3),
    vy:+b.vy.toFixed(3),
    team:b.team
  }));
  return {
    type:'state',
    W:room.W, H:room.H,
    gold: room.gold,
    core: room.coreHP,
    map: Array.from(room.map),
    hp:  Array.from(room.hp),
    owner: Array.from(room.owner),
    turrets: room.turrets.map(t=>({
      role: t.role, team:t.team, x:t.x,y:t.y,w:t.w,h:t.h, cx:t.cx,cy:t.cy,
      facingDir:t.facingDir, arcDeg:t.arcDeg, rangeCells:t.rangeCells
    })),
    bullets
  };
}
function broadcastState(room){
  broadcast(room, statePayload(room));
}
function broadcastRoomBrief(room){
  const playerCount = (room.players[1]?1:0) + (room.players[2]?1:0);
  const spectatorCount = room.spectators.size;
  broadcast(room, { type:'room', playerCount, spectatorCount });
}

/* -------------------- 刷新投票与重置 -------------------- */
function resetRoom(room){
  room.gold = {1:START_GOLD, 2:START_GOLD};
  room.coreHP = {p1:HP.core, p2:HP.core};
  room.turrets = [];
  room.bullets = [];
  room.bulletSeq = 1;
  genMap(room);
  broadcastState(room); // 立即一次
}
function handleRefreshRequest(ws){
  if(ws.__role!=='player' || !ws.__pid) return;
  if(room.pendingRefresh){
    ws.send(JSON.stringify({type:'refresh_result', ok:false, reason:'busy', from: room.pendingRefresh.initiator}));
    return;
  }
  const other = ws.__pid===1 ? room.players[2] : room.players[1];
  if(!other){
    ws.send(JSON.stringify({type:'refresh_result', ok:false, reason:'no_opponent'}));
    return;
  }
  room.pendingRefresh = { initiator: ws.__pid, deadline: Date.now()+VOTE_MS };
  if(other.ws.readyState===WebSocket.OPEN){
    other.ws.send(JSON.stringify({type:'refresh_prompt', from: ws.__pid, deadline: room.pendingRefresh.deadline}));
  }
  broadcast(room, {type:'refresh_status', state:'pending', from: ws.__pid, deadline: room.pendingRefresh.deadline});
}
function handleRefreshVote(ws, accept){
  if(ws.__role!=='player' || !ws.__pid) return;
  const pr = room.pendingRefresh;
  if(!pr) return;
  if(ws.__pid === pr.initiator) return;

  if(accept){
    room.pendingRefresh = null;
    resetRoom(room);
    broadcast(room, {type:'refresh_result', ok:true});
  }else{
    const from = pr.initiator;
    room.pendingRefresh = null;
    broadcast(room, {type:'refresh_result', ok:false, reason:'rejected', from});
  }
}

/* -------------------- 连接与消息 -------------------- */
wss.on('connection', (ws)=>{
  if(!room.players[1]){
    room.players[1] = { id:1, name:'P1', ws };
    ws.__role='player'; ws.__pid=1;
  }else if(!room.players[2]){
    room.players[2] = { id:2, name:'P2', ws };
    ws.__role='player'; ws.__pid=2;
  }else{
    room.spectators.add(ws);
    ws.__role='spectator'; ws.__pid=0;
  }

  const startMsg = { type:'start', role: ws.__role, W, H };
  if(ws.__role==='player') startMsg.you = ws.__pid;
  ws.send(JSON.stringify(startMsg));

  broadcastRoomBrief(room);
  if(!room.started) startGame(room);

  ws.on('message', (buf)=>{
    let m; try{ m=JSON.parse(buf.toString()); }catch{ return; }

    if(m.type==='join'){
      return; // 兼容旧客户端
    }

    if(m.type==='build' && ws.__role==='player'){
      const {kind,x,y,dir} = m;
      if(buildAt(room, ws.__pid, kind, x|0, y|0, (dir|0)&3)){
        broadcastState(room); // 事件即时广播一次
      }
      return;
    }

    if(m.type==='demolish' && ws.__role==='player'){
      const {x0,y0,x1,y1} = m;
      demolishRect(room, ws.__pid, x0|0,y0|0,x1|0,y1|0);
      broadcastState(room); // 事件即时广播一次
      return;
    }

    if(m.type==='refresh_request'){
      handleRefreshRequest(ws);
      return;
    }

    if(m.type==='refresh_vote'){
      handleRefreshVote(ws, !!m.accept);
      return;
    }
  });

  ws.on('close', ()=>{
    if(ws.__role==='player'){
      const pid=ws.__pid;
      if(pid) room.players[pid]=null;
    }else{
      room.spectators.delete(ws);
    }
    broadcastRoomBrief(room);
    if(!room.players[1] && !room.players[2]){ stopGame(room); }
    if(room.pendingRefresh){
      const other = room.pendingRefresh.initiator===1 ? room.players[2] : room.players[1];
      if(!other){ room.pendingRefresh=null; broadcast(room,{type:'refresh_result', ok:false, reason:'timeout'}); }
    }
  });
});

/* -------------------- 启动 -------------------- */
const PORT = process.env.PORT || 8080;
server.listen(PORT, ()=> console.log('Listening on :' + PORT));
