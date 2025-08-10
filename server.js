// server.js — 单房间 + 玩家/观战分配 + 扫掠网格(DDA)碰撞
// 一体化部署：静态托管 + 同端口 WebSocket + 地图生成 + 基本对战逻辑

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
const W = 100, H = 100;                    // 地图尺寸
const TICK_MS = 50;                        // 服务器帧率 20fps
const START_GOLD = 5000;                   // 初始金币
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

const clamp = (v,a,b)=>Math.max(a,Math.min(b,v));
const dist2 = (ax,ay,bx,by)=> (ax-bx)*(ax-bx)+(ay-by)*(ay-by);
const angleOfDir = (dir)=> [0, Math.PI/2, Math.PI, -Math.PI/2][dir|0];

/* -------------------- 单房间结构 -------------------- */
function newRoom(){
  return {
    // 在线：两个玩家位与观战列表
    players: {1:null, 2:null},            // {id, name, ws}
    spectators: [],                        // [{ws, name}]
    started: false,

    // 世界状态
    W, H,
    map: new Uint8Array(W*H),
    hp:  new Uint16Array(W*H),
    owner: new Uint8Array(W*H),
    gold: {1:START_GOLD, 2:START_GOLD},
    turrets: [],     // {id, role, team, x,y,w,h, cx,cy, facingDir, arcDeg, rangeCells, fireRate, bulletDamage, bulletSpeed, scatterDeg, cd}
    bullets: [],     // {id,x,y,vx,vy,team,life,damage}
    bulletSeq: 1,
    timer: null
  };
}
const room = newRoom();
genMap(room);

/* -------------------- 地图生成 -------------------- */
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
  // 3×3 方块，中心在 cx,cy
  const x = cx-1, y = cy-1, id = (team===1)?ID_CORE_P1:ID_CORE_P2;
  for(let j=0;j<3;j++) for(let i=0;i<3;i++){
    setCell(room, x+i, y+j, id, HP.core, team);
  }
  // 核心炮台（360°）
  room.turrets.push({
    id: 'core-'+team,
    role: 'core',
    team,
    x, y, w:3, h:3,
    cx: cx+0.0, cy: cy+0.0,
    facingDir: 0,
    arcDeg: 360,
    rangeCells: 16,
    fireRate: 2,                // 2 发/秒
    bulletDamage: 100,          // 伤害
    bulletSpeed: 24,            // 格/秒
    scatterDeg: 4,
    cd: 0
  });
}
function genMap(room){
  const {map,hp,owner} = room;
  map.fill(0); hp.fill(0); owner.fill(0);

  // 石头：~40%
  for(let y=0;y<H;y++){
    for(let x=0;x<W;x++){
      if(Math.random()<0.40){
        setCell(room,x,y,ID_ROCK,HP[ID_ROCK],0);
      }
    }
  }
  // 金子：低频聚类
  const clusters = 32;
  for(let k=0;k<clusters;k++){
    const cx = 4+Math.floor(Math.random()*(W-8));
    const cy = 4+Math.floor(Math.random()*(H-8));
    const r  = 3+Math.floor(Math.random()*3); // 3~5
    for(let y=cy-r;y<=cy+r;y++){
      for(let x=cx-r;x<=cx+r;x++){
        if(x<0||y<0||x>=W||y>=H) continue;
        const d2=(x-cx)*(x-cx)+(y-cy)*(y-cy);
        if(d2<=r*r && Math.random()<0.55){
          setCell(room,x,y,ID_GOLD,HP[ID_GOLD],0);
        }
      }
    }
  }

  // 放置两个核心：距边≥2格，核心中心相距 30~80 格
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
  // 对角可建：检查周边一圈是否存在己方建筑
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
      x,y,w:fp.w,h:fp.h, cx,cy, facingDir:dir, arcDeg:90, rangeCells:8, fireRate:1, bulletDamage:50, bulletSpeed:22, scatterDeg:2, cd:0 });
  }else if(kind==='ciws'){
    const cenDir = (dir+1)&3; // 近防炮：扇形指向宽边外侧
    room.turrets.push({ id:'c'+Date.now()+Math.random(), role:'ciws', team,
      x,y,w:fp.w,h:fp.h, cx,cy, facingDir:cenDir, arcDeg:180, rangeCells:3, fireRate:10, bulletDamage:50, bulletSpeed:28, scatterDeg:1, cd:0 });
  }else if(kind==='sniper'){
    room.turrets.push({ id:'s'+Date.now()+Math.random(), role:'sniper', team,
      x,y,w:fp.w,h:fp.h, cx,cy, facingDir:dir, arcDeg:45, rangeCells:20, fireRate:0.2, bulletDamage:500, bulletSpeed:36, scatterDeg:0, cd:0 });
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
function removeTurretAt(room,x,y){
  room.turrets = room.turrets.filter(t=> !(x>=t.x && y>=t.y && x<t.x+t.w && y<t.y+t.h) );
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
      if(o!==team) continue; // 只能拆己方
      if(v===ID_ROAD){ refund += COST.road*0.5; setCell(room,x,y,ID_EMPTY,0,0); }
      else if(v===ID_WALL){ refund += COST.wall*0.5; setCell(room,x,y,ID_EMPTY,0,0); }
      else if(v===ID_TURRET){ refund += COST.turret*0.5; setCell(room,x,y,ID_EMPTY,0,0); removeTurretAt(room,x,y); }
      else if(v===ID_CIWS){ refund += COST.ciws*0.5; setCell(room,x,y,ID_EMPTY,0,0); removeTurretAt(room,x,y); }
      else if(v===ID_SNIPER){ refund += COST.sniper*0.5; setCell(room,x,y,ID_EMPTY,0,0); removeTurretAt(room,x,y); }
    }
  }
  room.gold[team]+=Math.floor(refund);
}

/* -------------------- 射击与子弹 -------------------- */
function withinArc(tx,ty, t){
  const dx = tx - t.cx, dy = ty - t.cy;
  if(dx*dx + dy*dy > t.rangeCells*t.rangeCells) return false;
  if(t.arcDeg>=360) return true;
  const ang = Math.atan2(dy,dx);
  const center = angleOfDir(t.facingDir);
  let d = Math.atan2(Math.sin(ang-center), Math.cos(ang-center)); // wrap [-pi,pi]
  const half = (t.arcDeg*Math.PI/180)/2;
  return Math.abs(d) <= half + 1e-6;
}
function tryShoot(room, t, dt){
  t.cd -= dt;
  if(t.cd>0) return;

  // 目标优先级
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
      const cx = x+0.5, cy = y+0.5;
      if(!withinArc(cx,cy,t)) continue;
      const s = prio(id); if(s===0) continue;
      const d2v = dist2(t.cx,t.cy, cx,cy);
      if(s>bestScore || (s===bestScore && d2v<bestDist)){
        best = {x:cx, y:cy}; bestScore=s; bestDist=d2v;
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
    const life = t.rangeCells / speed;     // 足以飞到最远距离
    room.bullets.push({ id, x:t.cx, y:t.cy, vx, vy, team:t.team, life, damage:t.bulletDamage||100 });
    t.cd = 1/(t.fireRate||1);
  }
}

// 扫掠网格(DDA)碰撞：子弹不会穿过石头/金子/敌方建筑
function stepBullets(room, dt){
  const { map, hp, owner } = room;

  for (const b of room.bullets){
    b.life -= dt;
    if (b.life <= 0) { b.dead = true; continue; }
    if ((b.vx === 0 && b.vy === 0)) { b.dead = true; continue; }

    let remain = dt;

    while (remain > 1e-6 && !b.dead) {
      const vx = b.vx, vy = b.vy;

      const cx = Math.floor(b.x);
      const cy = Math.floor(b.y);

      const stepX = vx > 0 ? 1 : (vx < 0 ? -1 : 0);
      const stepY = vy > 0 ? 1 : (vy < 0 ? -1 : 0);

      let tToX = Infinity, tToY = Infinity;
      if (stepX !== 0) {
        const nextGridX = (stepX > 0 ? (cx + 1) : cx) - b.x;
        tToX = nextGridX / vx;
        if (tToX < 0) tToX = Infinity;
      }
      if (stepY !== 0) {
        const nextGridY = (stepY > 0 ? (cy + 1) : cy) - b.y;
        tToY = nextGridY / vy;
        if (tToY < 0) tToY = Infinity;
      }

      if (!isFinite(tToX) && !isFinite(tToY)) {
        b.x += vx * remain; b.y += vy * remain; remain = 0; break;
      }

      const tStep = Math.min(remain, Math.min(tToX, tToY));

      // 进入的新格
      const enterX = cx + (tToX <= tToY ? stepX : 0);
      const enterY = cy + (tToY <  tToX ? stepY : 0);

      // 先移动到边界（略加 eps）
      const eps = 1e-6;
      b.x += vx * tStep; b.y += vy * tStep;
      if (tToX <= tToY) b.x += stepX * eps; else b.y += stepY * eps;

      remain -= tStep;

      if (enterX < 0 || enterY < 0 || enterX >= W || enterY >= H) {
        b.dead = true; break;
      }

      const i = enterY * W + enterX;
      const v = map[i];

      if (v !== ID_EMPTY) {
        // 己方格可穿越；敌对/中立命中即停并结算
        if (owner[i] !== b.team) {
          const damage = Math.min(b.damage, hp[i]);
          hp[i] -= damage;
          if (hp[i] <= 0) {
            if (v === ID_GOLD) { room.gold[b.team] += REWARD_GOLD; }
            if (v === ID_TURRET || v === ID_CIWS || v === ID_SNIPER) { removeTurretAt(room, enterX, enterY); }
            setCell(room, enterX, enterY, ID_EMPTY, 0, 0);
          }
          b.dead = true;
        }
      }
    }
  }
  room.bullets = room.bullets.filter(b=>!b.dead);
}

function stepTurrets(room, dt){
  for(const t of room.turrets){
    tryShoot(room, t, dt);
  }
}

/* -------------------- 游戏循环与广播 -------------------- */
function startGame(room){
  if(room.timer) return;
  room.started = true;
  room.timer = setInterval(()=>{
    stepTurrets(room, TICK_MS/1000);
    stepBullets(room, TICK_MS/1000);
    checkWin(room);
    broadcastState(room);
  }, TICK_MS);
}
function stopGame(room){
  if(room.timer){ clearInterval(room.timer); room.timer=null; }
  room.started=false;
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
  }
}
function broadcast(room, msg){
  // 全体：两位玩家 + 观战
  for (const pid of [1,2]) {
    const p = room.players[pid];
    if(p && p.ws.readyState===WebSocket.OPEN) p.ws.send(JSON.stringify(msg));
  }
  for (const s of room.spectators) {
    if (s.ws.readyState===WebSocket.OPEN) s.ws.send(JSON.stringify(msg));
  }
}
function statePayload(room){
  return {
    type:'state',
    W:room.W, H:room.H,
    gold: room.gold,
    map: Array.from(room.map),
    hp:  Array.from(room.hp),
    owner: Array.from(room.owner),
    turrets: room.turrets.map(t=>({
      role: t.role, team:t.team, x:t.x,y:t.y,w:t.w,h:t.h, cx:t.cx,cy:t.cy,
      facingDir:t.facingDir, arcDeg:t.arcDeg, rangeCells:t.rangeCells
    })),
    bullets: room.bullets.map(b=>({id:b.id,x:b.x,y:b.y,vx:b.vx,vy:b.vy,team:b.team,fade:0}))
  };
}
function broadcastState(room){
  broadcast(room, statePayload(room));
}
function broadcastRoomInfo(room){
  const playerCount = (room.players[1]?1:0) + (room.players[2]?1:0);
  const spectatorCount = room.spectators.length;
  broadcast(room, { type:'room', playerCount, spectatorCount });
}

/* -------------------- 连接与消息 -------------------- */
wss.on('connection', (ws)=>{
  ws.on('message', (buf)=>{
    let m; try{ m=JSON.parse(buf.toString()); }catch{ return; }

    if(m.type==='join'){
      const name = String(m.name||'Guest');

      // 分配：若有空位→玩家；否则→观战
      let role = 'spectator';
      let pid  = 0;
      if(!room.players[1]){ role='player'; pid=1; room.players[1]={id:1,name,ws}; ws.__pid=1; }
      else if(!room.players[2]){ role='player'; pid=2; room.players[2]={id:2,name,ws}; ws.__pid=2; }
      else{ role='spectator'; pid=0; room.spectators.push({ws,name}); }

      ws.__role = role;

      // 启动与同步
      if(!room.started) startGame(room);
      ws.send(JSON.stringify({type:'start', role, you:pid, W, H}));
      ws.send(JSON.stringify(statePayload(room)));
      broadcastRoomInfo(room);
      return;
    }

    if(m.type==='build' || m.type==='demolish'){
      if(ws.__role!=='player') return; // 观战者无权操作
    }

    if(m.type==='build'){
      const pid = ws.__pid|0;
      const {kind,x,y,dir} = m;
      if(buildAt(room, pid, kind, x|0, y|0, (dir|0)&3)){
        broadcastState(room);
      }
      return;
    }

    if(m.type==='demolish'){
      const pid = ws.__pid|0;
      const {x0,y0,x1,y1} = m;
      demolishRect(room, pid, x0|0,y0|0,x1|0,y1|0);
      broadcastState(room);
      return;
    }
  });

  ws.on('close', ()=>{
    const role = ws.__role;
    if(role==='player'){
      const pid = ws.__pid|0;
      if(pid===1 || pid===2){
        room.players[pid] = null;
      }
    }else{
      room.spectators = room.spectators.filter(s => s.ws !== ws);
    }
    broadcastRoomInfo(room);
    // 无玩家且无人观战时可停表
    if(!room.players[1] && !room.players[2] && room.spectators.length===0){
      stopGame(room);
    }
  });
});

/* -------------------- 启动 -------------------- */
const PORT = process.env.PORT || 8080;
server.listen(PORT, ()=> console.log('Listening on :' + PORT));
