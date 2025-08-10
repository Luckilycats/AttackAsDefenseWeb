// network.js — 简单联机封装
const Net = {
  ws: null, you: 0, roomId: null, connected: false, started: false, W:0, H:0,
  onRoom:  (info)=>{}, onStart:(start)=>{}, onState:(s)=>{}, onEnded:(e)=>{}, onError:(e)=>{},
  connect({ url='ws://localhost:8080', roomId, name='Player', create=false }){
    if(this.ws) try{ this.ws.close(); }catch{}
    this.ws = new WebSocket(url);
    this.roomId = roomId; this.connected=false; this.started=false;
    this.ws.onopen = () => { this.connected=true; this.send({ t:'hello', roomId, name, create:!!create }); };
    this.ws.onmessage = (ev) => {
      let m; try{ m=JSON.parse(ev.data); }catch{ return; }
      if(m.t==='error'){ this.onError(m); return; }
      if(m.t==='joined'){ this.you=m.team; }
      if(m.t==='room'){ this.onRoom(m); }
      if(m.t==='start'){ this.started=true; this.W=m.W; this.H=m.H; this.onStart(m); }
      if(m.t==='state'){ this.onState(m); }
      if(m.t==='ended'){ this.onEnded(m); }
    };
    this.ws.onclose = () => { this.connected=false; this.started=false; };
  },
  ready(flag=true){ this.send({ t:'ready', ready: !!flag }); },
  sendCmd(cmd){ this.send({ t:'cmd', cmd }); },
  build(kind,x,y,dir){ this.sendCmd({ type:'build', kind, x,y, dir }); },
  demolish(x0,y0,x1,y1){ this.sendCmd({ type:'demolish', x0,y0,x1,y1 }); },
  send(obj){ if(this.ws && this.ws.readyState===WebSocket.OPEN) this.ws.send(JSON.stringify(obj)); }
};
window.Net = Net;
