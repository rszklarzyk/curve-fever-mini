const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
app.use(express.static(__dirname + '/public'));

// --- Ustawienia gry ---
const W = 800, H = 600;
const SPEED = 1.12;       // px na tick (o 30% wolniej niż pierwotne 1.6)
const TURN = 0.065;       // rad na tick
const R = 2;              // promień linii (grubość = 4px)
const TPS = 60;           // ticki na sekundę
const COUNTDOWN = 120;    // 2 s przed startem rundy
const END_PAUSE = 180;    // 3 s po końcu rundy
const GAP_LEN = 14;       // długość dziury w linii (ticki)
const SELF_GRACE = 14;    // ile ticków własny ślad jest "bezpieczny"
// Bonusy
const PU_TYPES = ['reverse', 'ghost', 'shrink', 'speed', 'beer', 'vodka'];
const PU_R = 12;          // promień bonusu
const PU_MAX = 3;         // maks. bonusów na mapie naraz
const EFFECT = 10 * TPS;  // czas działania bonusu (10 s)
const SHRINK = 0.1;       // o tyle mapa kurczy się z każdej strony (razem 20%)
const SHRINK_ANIM = 2 * TPS; // kurczenie trwa 2 s
const FAST = 2;           // mnożnik prędkości przeciwników po bonusie "speed"
const BEER_FAST = 1.5;    // Czarna Perła: zbierający jedzie 1.5x szybciej (i przenika linie)
const FREEZE = 15 * TPS;  // Soplica: WSZYSCY (też zbierający) stoją w miejscu 15 s
const COLORS = ['#ff4d4d', '#4da6ff', '#5cd65c', '#ffd11a', '#d966ff', '#ff9933', '#33ffcc', '#ff66b3'];

const rooms = new Map();
const rand = (a, b) => a + Math.random() * (b - a);

function getRoom(id) {
  if (!rooms.has(id)) {
    rooms.set(id, { id, players: new Map(), state: 'lobby', hostId: null, nextIdx: 1, timer: null });
  }
  return rooms.get(id);
}

function publicPlayers(room) {
  return [...room.players.values()].map(p => ({
    id: p.id, idx: p.idx, name: p.name, color: p.color, score: p.score, alive: p.alive,
  }));
}

function sendLobby(room) {
  io.to(room.id).emit('lobby', { players: publicPlayers(room), hostId: room.hostId, state: room.state });
}

function startGame(room) {
  room.state = 'playing';
  for (const p of room.players.values()) p.score = 0;
  newRound(room);
  room.timer = setInterval(() => step(room), 1000 / TPS);
}

function stopGame(room) {
  clearInterval(room.timer);
  room.timer = null;
  room.state = 'lobby';
}

function newRound(room) {
  room.grid = new Int32Array(W * H);   // moveTick gracza w chwili zamalowania piksela
  room.owner = new Uint16Array(W * H); // idx gracza
  room.tick = 0;
  room.countdown = COUNTDOWN;
  room.endTimer = 0;
  room.roundPlayers = room.players.size;
  room.powerups = [];
  room.puTimer = Math.floor(rand(1.5, 3) * TPS);
  room.nextPuId = 1;
  room.shrinkStart = room.shrinkEnd = 0;
  room.shrinkBy = null;
  room.freezeStart = room.freezeEnd = 0;
  room.freezeBy = null;
  for (const p of room.players.values()) {
    p.reverseUntil = p.ghostUntil = p.speedUntil = p.boostUntil = p.frozenUntil = 0;
    p.reverseBy = p.speedBy = null;
    p.alive = true;
    p.x = rand(100, W - 100);
    p.y = rand(100, H - 100);
    p.angle = rand(0, Math.PI * 2);
    p.moveTick = 0;
    p.gapLeft = 0;
    p.gapTimer = Math.floor(rand(90, 240));
  }
  io.to(room.id).emit('roundStart', {
    players: publicPlayers(room).map(pp => {
      const p = room.players.get(pp.id);
      return { ...pp, x: p.x, y: p.y, angle: p.angle };
    }),
    countdown: COUNTDOWN / TPS,
  });
  sendFx(room);
  sendLobby(room);
}

// Aktualne granice mapy (mniejsze, gdy działa bonus "shrink")
function bounds(room) {
  let k = 0;
  if (room.tick < room.shrinkEnd) k = SHRINK * Math.min(1, (room.tick - room.shrinkStart) / SHRINK_ANIM);
  return { x0: W * k, y0: H * k, x1: W * (1 - k), y1: H * (1 - k) };
}

function sendFx(room) {
  io.to(room.id).emit('fx', {
    tick: room.tick,
    powerups: room.powerups,
    shrinkStart: room.shrinkStart, shrinkEnd: room.shrinkEnd, shrinkBy: room.shrinkBy,
    freezeStart: room.freezeStart, freezeEnd: room.freezeEnd, freezeBy: room.freezeBy,
    players: [...room.players.values()].map(p => ({
      idx: p.idx, reverseUntil: p.reverseUntil, reverseBy: p.reverseBy, ghostUntil: p.ghostUntil,
      speedUntil: p.speedUntil, speedBy: p.speedBy, boostUntil: p.boostUntil, frozenUntil: p.frozenUntil,
    })),
  });
}

function applyPowerup(room, p, type) {
  const until = room.tick + EFFECT;
  if (type === 'reverse') {
    for (const o of room.players.values()) if (o !== p && o.alive) { o.reverseUntil = until; o.reverseBy = p.name; }
  } else if (type === 'speed') {
    for (const o of room.players.values()) if (o !== p && o.alive) { o.speedUntil = until; o.speedBy = p.name; }
  } else if (type === 'beer') {
    p.boostUntil = p.ghostUntil = until;
  } else if (type === 'vodka') {
    room.freezeStart = room.tick;
    room.freezeEnd = room.tick + FREEZE;
    room.freezeBy = p.name;
    for (const o of room.players.values()) if (o.alive) o.frozenUntil = room.freezeEnd;
  } else if (type === 'ghost') {
    p.ghostUntil = until;
  } else if (type === 'shrink') {
    if (room.tick >= room.shrinkEnd) room.shrinkStart = room.tick;
    room.shrinkEnd = until;
    room.shrinkBy = p.name;
  }
}

function hits(room, p, x, y) {
  const b = bounds(room);
  if (x < b.x0 + R || y < b.y0 + R || x >= b.x1 - R || y >= b.y1 - R) return true;
  if (p.ghostUntil > room.tick) return false; // przenikanie przez linie
  const cx = Math.round(x), cy = Math.round(y);
  for (let dy = -R; dy <= R; dy++) {
    for (let dx = -R; dx <= R; dx++) {
      if (dx * dx + dy * dy > R * R) continue;
      const i = (cy + dy) * W + (cx + dx);
      const t = room.grid[i];
      if (!t) continue;
      if (room.owner[i] !== p.idx || t < p.moveTick - SELF_GRACE) return true;
    }
  }
  return false;
}

function paint(room, p) {
  const cx = Math.round(p.x), cy = Math.round(p.y);
  for (let dy = -R; dy <= R; dy++) {
    for (let dx = -R; dx <= R; dx++) {
      if (dx * dx + dy * dy > R * R) continue;
      const x = cx + dx, y = cy + dy;
      if (x < 0 || y < 0 || x >= W || y >= H) continue;
      const i = y * W + x;
      if (!room.grid[i]) { room.grid[i] = p.moveTick; room.owner[i] = p.idx; }
    }
  }
}

function step(room) {
  if (room.endTimer > 0) {
    if (--room.endTimer === 0) newRound(room);
    return;
  }
  if (room.countdown > 0) { room.countdown--; return; }

  room.tick++;
  const alive = [...room.players.values()].filter(p => p.alive);
  const died = [];

  for (const p of alive) {
    if (p.frozenUntil > room.tick) { p.drawing = false; continue; } // Soplica: stoi w miejscu
    p.moveTick++; // liczy tylko ticki ruchu (wiek własnego śladu)
    p.angle += (p.reverseUntil > room.tick ? -p.turn : p.turn) * TURN;
    const sp = SPEED * (p.speedUntil > room.tick ? FAST : 1) * (p.boostUntil > room.tick ? BEER_FAST : 1);
    p.x += Math.cos(p.angle) * sp;
    p.y += Math.sin(p.angle) * sp;

    if (p.gapLeft > 0) p.gapLeft--;
    else if (--p.gapTimer <= 0) { p.gapLeft = GAP_LEN; p.gapTimer = Math.floor(rand(90, 240)); }
    p.drawing = p.gapLeft === 0;

    if (hits(room, p, p.x, p.y)) died.push(p);
  }
  for (const p of alive) if (p.drawing && !died.includes(p)) paint(room, p);

  // Zbieranie bonusów
  let fxChanged = false;
  for (const p of alive) {
    if (died.includes(p)) continue;
    const hit = room.powerups.find(u => (u.x - p.x) ** 2 + (u.y - p.y) ** 2 < (PU_R + R + 2) ** 2);
    if (hit) {
      room.powerups = room.powerups.filter(u => u !== hit);
      applyPowerup(room, p, hit.type);
      fxChanged = true;
    }
  }
  // Pojawianie się nowych bonusów
  if (room.tick >= room.freezeEnd && --room.puTimer <= 0) { // w czasie Soplicy nic nowego się nie pojawia
    room.puTimer = Math.floor(rand(3, 6) * TPS);
    if (room.powerups.length < PU_MAX) {
      const b = bounds(room), m = 40;
      room.powerups.push({
        id: room.nextPuId++,
        type: PU_TYPES[Math.floor(Math.random() * PU_TYPES.length)],
        x: Math.round(rand(b.x0 + m, b.x1 - m)),
        y: Math.round(rand(b.y0 + m, b.y1 - m)),
      });
      fxChanged = true;
    }
  }
  if (fxChanged) sendFx(room);

  // Punkt dla każdego, kto przeżył czyjąś śmierć
  for (const d of died) {
    d.alive = false;
    for (const p of room.players.values()) if (p.alive) p.score++;
  }

  io.to(room.id).emit('tick', room.tick, alive.map(p => [p.idx, +p.x.toFixed(1), +p.y.toFixed(1), p.drawing ? 1 : 0, p.alive ? 1 : 0]));
  if (died.length) sendLobby(room);

  const left = [...room.players.values()].filter(p => p.alive);
  if (left.length === 0 || (room.roundPlayers > 1 && left.length <= 1)) {
    room.endTimer = END_PAUSE;
    io.to(room.id).emit('roundEnd', { winner: left[0] ? left[0].name : null });
  }
}

io.on('connection', socket => {
  let room = null;

  socket.on('join', ({ roomId, name }) => {
    if (room) return;
    roomId = String(roomId || '').replace(/[^a-z0-9]/gi, '').slice(0, 20).toLowerCase();
    if (!roomId) return socket.emit('err', 'Zły kod pokoju');
    const r = getRoom(roomId);
    if (r.players.size >= COLORS.length) return socket.emit('err', 'Pokój jest pełny');
    room = r;
    socket.join(room.id);
    const used = new Set([...room.players.values()].map(p => p.color));
    room.players.set(socket.id, {
      id: socket.id,
      idx: room.nextIdx++,
      name: String(name || 'Gracz').slice(0, 16),
      color: COLORS.find(c => !used.has(c)),
      score: 0, alive: false, turn: 0,
    });
    if (!room.hostId) room.hostId = socket.id;
    socket.emit('joined', { id: socket.id, roomId: room.id });
    sendLobby(room);
  });

  socket.on('input', dir => {
    const p = room && room.players.get(socket.id);
    if (p) p.turn = Math.max(-1, Math.min(1, dir | 0));
  });

  socket.on('start', () => {
    if (room && room.hostId === socket.id && room.state === 'lobby') startGame(room);
  });

  socket.on('stop', () => {
    if (room && room.hostId === socket.id && room.state === 'playing') { stopGame(room); sendLobby(room); }
  });

  socket.on('disconnect', () => {
    if (!room) return;
    room.players.delete(socket.id);
    if (room.players.size === 0) { stopGame(room); rooms.delete(room.id); return; }
    if (room.hostId === socket.id) room.hostId = room.players.keys().next().value;
    sendLobby(room);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Curve Fever mini: http://localhost:${PORT}`));
