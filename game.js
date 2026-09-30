'use strict';

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------

// Tree sizes. A tool can cut any tree whose size index <= the tool's tier.
const TREES = [
  { name: 'Sapling',         hp: 3,   wood: 1   },
  { name: 'Young Birch',     hp: 8,   wood: 3   },
  { name: 'Pine',            hp: 24,  wood: 8   },
  { name: 'Oak',             hp: 70,  wood: 22  },
  { name: 'Old Fir',         hp: 180, wood: 55  },
  { name: 'Ancient Redwood', hp: 500, wood: 160 },
];

const TOOLS = [
  { name: 'Pocket Knife', dmg: 1,  cost: 0,    desc: 'Barely cuts a sapling.' },
  { name: 'Hatchet',      dmg: 2,  cost: 15,   desc: 'Cuts young birches.' },
  { name: 'Axe',          dmg: 4,  cost: 60,   desc: 'Cuts pines.',            needs: 'workbench' },
  { name: 'Felling Axe',  dmg: 9,  cost: 180,  desc: 'Cuts oaks.',             needs: 'workbench' },
  { name: 'Crosscut Saw', dmg: 20, cost: 450,  desc: 'Cuts old firs.',         needs: 'sawmill' },
  { name: 'Chainsaw',     dmg: 45, cost: 1200, desc: 'Cuts ancient redwoods.', needs: 'sawmill' },
];

const BUILDINGS = {
  workbench:  { name: 'Workbench',   cost: 10,  unique: true, desc: 'Lets you craft the Axe and Felling Axe.' },
  woodshed:   { name: 'Woodshed',    cost: 20,  desc: '+100 wood storage.' },
  cabin:      { name: 'Cabin',       cost: 80,  desc: 'A lumberjack moves in and chops for you.' },
  sawmill:    { name: 'Sawmill',     cost: 150, unique: true, desc: '+50% wood per tree. Unlocks saws.' },
  lumberyard: { name: 'Lumber Yard', cost: 300, desc: '+600 wood storage.' },
};

const BASE_CAP = 25;
const MILESTONES = [100, 200, 400, 750, 1200, 2000, 3000, 4500, 6500];

const MAP = 96;               // map is MAP x MAP tiles
const CENTER = MAP / 2;
const START_RADIUS = 4.5;
const SWING_TIME = 0.35;      // seconds between swings
const PLAYER_SPEED = 4.5;     // tiles per second
const REACH = 1.6;            // chop reach in tiles (center to center)
const SAVE_KEY = 'woodworld-save-v1';

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let state;        // persisted
let tiles;        // tiles[y*MAP+x] = { tree: size|-1, hp, building: id|null, stump: bool }
let helpers = []; // lumberjacks (rebuilt from cabins on load)
const particles = [];
const floaters = [];

function seededRandom(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Per-tile deterministic jitter so the forest looks organic.
function tileHash(x, y) {
  let h = (x * 374761393 + y * 668265263) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function newGame() {
  const seed = (Math.random() * 1e9) | 0;
  const rand = seededRandom(seed);
  tiles = new Array(MAP * MAP);
  for (let y = 0; y < MAP; y++) {
    for (let x = 0; x < MAP; x++) {
      const d = Math.hypot(x + 0.5 - CENTER, y + 0.5 - CENTER);
      let tree = -1;
      if (d >= START_RADIUS) {
        // Trees get bigger the deeper into the forest you go.
        tree = Math.floor((d - 5) / 6 + rand() * 1.3);
        if (d < 7.5) tree = 0;
        tree = Math.max(0, Math.min(TREES.length - 1, tree));
      }
      tiles[y * MAP + x] = { tree, hp: tree >= 0 ? TREES[tree].hp : 0, building: null, stump: false };
    }
  }
  state = {
    seed,
    wood: 0,
    tool: 0,
    felled: 0,
    milestone: 0,
    player: { x: CENTER + 0.5, y: CENTER + 0.5 },
  };
  helpers = [];
}

function saveGame() {
  try {
    const t = tiles.map(tl => [tl.tree, tl.hp, tl.building, tl.stump ? 1 : 0]);
    localStorage.setItem(SAVE_KEY, JSON.stringify({ state, tiles: t }));
  } catch (e) { /* storage unavailable: play without saving */ }
}

function loadGame() {
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    if (!raw) return false;
    const data = JSON.parse(raw);
    if (!data.tiles || data.tiles.length !== MAP * MAP) return false;
    state = data.state;
    tiles = data.tiles.map(([tree, hp, building, stump]) => ({ tree, hp, building, stump: !!stump }));
    helpers = [];
    tiles.forEach((tl, i) => {
      if (tl.building === 'cabin') spawnHelper(i % MAP, Math.floor(i / MAP));
    });
    return true;
  } catch (e) {
    return false;
  }
}

// ---------------------------------------------------------------------------
// World helpers
// ---------------------------------------------------------------------------

const inBounds = (x, y) => x >= 0 && y >= 0 && x < MAP && y < MAP;
const tileAt = (x, y) => (inBounds(x, y) ? tiles[y * MAP + x] : null);
const walkable = (x, y) => { const t = tileAt(x, y); return !!t && t.tree < 0 && !t.building; };

function countBuildings(id) {
  let n = 0;
  for (const t of tiles) if (t.building === id) n++;
  return n;
}

function woodCap() {
  return BASE_CAP + countBuildings('woodshed') * 100 + countBuildings('lumberyard') * 600;
}

function clearingSize() {
  let n = 0;
  for (const t of tiles) if (t.tree < 0) n++;
  return n;
}

function addWood(amount) {
  const cap = woodCap();
  const before = state.wood;
  state.wood = Math.min(cap, state.wood + amount);
  if (state.wood === cap && before + amount > cap) toast('Storage full! Build a Woodshed.');
  return state.wood - before;
}

// Breadth-first search over walkable tiles. Returns a list of tiles to step
// through (excluding the start), or null if no goal is reachable.
function findPath(sx, sy, isGoal, maxNodes = 6000) {
  const start = sy * MAP + sx;
  const prev = new Map([[start, -1]]);
  const queue = [start];
  let head = 0;
  while (head < queue.length && head < maxNodes) {
    const cur = queue[head++];
    const cx = cur % MAP, cy = (cur / MAP) | 0;
    if (isGoal(cx, cy)) {
      const path = [];
      for (let n = cur; n !== start; n = prev.get(n)) path.push({ x: n % MAP, y: (n / MAP) | 0 });
      return path.reverse();
    }
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = cx + dx, ny = cy + dy;
      const ni = ny * MAP + nx;
      if (!prev.has(ni) && walkable(nx, ny)) {
        prev.set(ni, cur);
        queue.push(ni);
      }
    }
  }
  return null;
}

// Is tile (tx,ty) within chopping reach of a position?
const inReach = (px, py, tx, ty) => Math.hypot(tx + 0.5 - px, ty + 0.5 - py) <= REACH;

// Move an entity with a radius, sliding along blocked tiles.
function moveEntity(e, dx, dy, r = 0.3) {
  const blocked = (x, y) =>
    !walkable(Math.floor(x - r), Math.floor(y - r)) || !walkable(Math.floor(x + r), Math.floor(y - r)) ||
    !walkable(Math.floor(x - r), Math.floor(y + r)) || !walkable(Math.floor(x + r), Math.floor(y + r));
  if (!blocked(e.x + dx, e.y)) e.x += dx;
  if (!blocked(e.x, e.y + dy)) e.y += dy;
}

// Step along a path of tile centers. Returns true when the path is finished.
function followPath(e, speed, dt) {
  if (!e.path || !e.path.length) return true;
  const wp = e.path[0];
  const tx = wp.x + 0.5, ty = wp.y + 0.5;
  const dx = tx - e.x, dy = ty - e.y;
  const dist = Math.hypot(dx, dy);
  const step = speed * dt;
  if (!walkable(wp.x, wp.y)) { e.path = null; return true; }
  if (dist <= step) {
    e.x = tx; e.y = ty;
    e.path.shift();
  } else {
    e.x += (dx / dist) * step;
    e.y += (dy / dist) * step;
  }
  if (Math.abs(dx) > Math.abs(dy)) e.face = { x: Math.sign(dx), y: 0 };
  else if (dy) e.face = { x: 0, y: Math.sign(dy) };
  e.walkAnim = (e.walkAnim || 0) + dt * 10;
  return e.path.length === 0;
}

// ---------------------------------------------------------------------------
// Chopping
// ---------------------------------------------------------------------------

// Hit a tree. Returns 'felled', 'hit', or 'too-big'.
function chop(tx, ty, tier, dmg, byPlayer) {
  const t = tileAt(tx, ty);
  if (!t || t.tree < 0) return 'gone';
  if (t.tree > tier) return 'too-big';
  t.hp -= dmg;
  spawnChips(tx + 0.5, ty + 0.5, 4);
  t.shake = 0.15;
  shaking.add(t);
  if (t.hp > 0) return 'hit';

  const info = TREES[t.tree];
  let wood = info.wood;
  if (countBuildings('sawmill') > 0) wood = Math.ceil(wood * 1.5);
  const gained = addWood(wood);
  floaters.push({ x: tx + 0.5, y: ty + 0.2, text: `+${gained}`, life: 1.2, color: byPlayer ? '#ffd27a' : '#bde38a' });
  spawnChips(tx + 0.5, ty + 0.5, 14);
  t.tree = -1;
  t.hp = 0;
  t.stump = tileHash(tx, ty) < 0.6;
  state.felled++;
  checkMilestones();
  refreshUI();
  return 'felled';
}

function checkMilestones() {
  const size = clearingSize();
  while (state.milestone < MILESTONES.length && size >= MILESTONES[state.milestone]) {
    toast(`Your clearing has grown to ${MILESTONES[state.milestone]} tiles!`);
    state.milestone++;
  }
}

let lastTooBigToast = 0;
function tooBig(tx, ty) {
  const now = performance.now();
  if (now - lastTooBigToast < 1500) return;
  lastTooBigToast = now;
  const size = tileAt(tx, ty).tree;
  toast(`That ${TREES[size].name} is too big for your ${TOOLS[state.tool].name}. You need a ${TOOLS[size].name}.`);
}

// ---------------------------------------------------------------------------
// Player
// ---------------------------------------------------------------------------

const player = {
  x: CENTER, y: CENTER, face: { x: 0, y: 1 }, path: null,
  target: null, // tree we're walking to / chopping
  swing: 0,     // cooldown
  swingAnim: 0,
  walkAnim: 0,
};

// Pick the best tree in reach, favoring the facing direction.
function treeInReach() {
  const px = player.x, py = player.y;
  let best = null, bestScore = -Infinity;
  for (let y = Math.floor(py) - 2; y <= Math.floor(py) + 2; y++) {
    for (let x = Math.floor(px) - 2; x <= Math.floor(px) + 2; x++) {
      const t = tileAt(x, y);
      if (!t || t.tree < 0 || !inReach(px, py, x, y)) continue;
      const dx = x + 0.5 - px, dy = y + 0.5 - py;
      const d = Math.hypot(dx, dy) || 1;
      const score = (dx * player.face.x + dy * player.face.y) / d - d * 0.5;
      if (score > bestScore) { bestScore = score; best = { x, y }; }
    }
  }
  return best;
}

function swingAt(tx, ty) {
  if (player.swing > 0) return;
  player.swing = SWING_TIME;
  player.swingAnim = SWING_TIME;
  const dx = tx + 0.5 - player.x, dy = ty + 0.5 - player.y;
  player.face = Math.abs(dx) > Math.abs(dy) ? { x: Math.sign(dx), y: 0 } : { x: 0, y: Math.sign(dy) || 1 };
  const r = chop(tx, ty, state.tool, TOOLS[state.tool].dmg, true);
  if (r === 'too-big') { tooBig(tx, ty); player.target = null; }
  if (r === 'felled' || r === 'gone') player.target = null;
}

function updatePlayer(dt) {
  player.swing = Math.max(0, player.swing - dt);
  player.swingAnim = Math.max(0, player.swingAnim - dt);

  let mx = 0, my = 0;
  if (keys.has('ArrowLeft') || keys.has('KeyA')) mx -= 1;
  if (keys.has('ArrowRight') || keys.has('KeyD')) mx += 1;
  if (keys.has('ArrowUp') || keys.has('KeyW')) my -= 1;
  if (keys.has('ArrowDown') || keys.has('KeyS')) my += 1;

  if (mx || my) {
    // Keyboard overrides click-to-move.
    player.path = null;
    player.target = null;
    const len = Math.hypot(mx, my);
    moveEntity(player, (mx / len) * PLAYER_SPEED * dt, (my / len) * PLAYER_SPEED * dt);
    player.face = Math.abs(mx) >= Math.abs(my) ? { x: mx, y: 0 } : { x: 0, y: my };
    player.walkAnim += dt * 10;
  } else if (player.path) {
    if (followPath(player, PLAYER_SPEED, dt)) player.path = null;
  }

  if (keys.has('Space')) {
    const t = treeInReach();
    if (t) swingAt(t.x, t.y);
  } else if (player.target && !player.path) {
    const { x, y } = player.target;
    if (tileAt(x, y).tree < 0) player.target = null;
    else if (inReach(player.x, player.y, x, y)) swingAt(x, y);
    else player.target = null; // couldn't get there
  }

  state.player.x = player.x;
  state.player.y = player.y;
}

// ---------------------------------------------------------------------------
// Helpers (lumberjacks from cabins)
// ---------------------------------------------------------------------------

function spawnHelper(cx, cy) {
  // Start next to the cabin.
  let sx = cx, sy = cy;
  for (const [dx, dy] of [[0, 1], [1, 0], [-1, 0], [0, -1]]) {
    if (walkable(cx + dx, cy + dy)) { sx = cx + dx; sy = cy + dy; break; }
  }
  helpers.push({ x: sx + 0.5, y: sy + 0.5, path: null, target: null, swing: 0, swingAnim: 0, retry: 0, face: { x: 0, y: 1 }, walkAnim: 0 });
}

// Helpers use a tool one tier below yours (at least a hatchet), and swing slower.
const helperTier = () => Math.max(1, state.tool - 1);
const helperDmg = () => Math.max(1, Math.floor(TOOLS[helperTier()].dmg * 0.6));

function updateHelper(h, dt) {
  h.swing = Math.max(0, h.swing - dt);
  h.swingAnim = Math.max(0, h.swingAnim - dt);
  h.retry = Math.max(0, h.retry - dt);

  if (h.target && tileAt(h.target.x, h.target.y).tree < 0) { h.target = null; h.path = null; }

  if (!h.target) {
    if (h.retry > 0) return;
    const tier = helperTier();
    const taken = new Set(helpers.filter(o => o !== h && o.target).map(o => o.target.y * MAP + o.target.x));
    let found = null;
    const path = findPath(Math.floor(h.x), Math.floor(h.y), (x, y) => {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const t = tileAt(x + dx, y + dy);
          if (t && t.tree >= 0 && t.tree <= tier && !taken.has((y + dy) * MAP + x + dx)) {
            found = { x: x + dx, y: y + dy };
            return true;
          }
        }
      }
      return false;
    });
    if (!path) { h.retry = 3; return; }
    h.path = path;
    h.target = found;
  }

  if (h.path && h.path.length) {
    followPath(h, PLAYER_SPEED * 0.6, dt);
    return;
  }
  h.path = null;
  if (inReach(h.x, h.y, h.target.x, h.target.y)) {
    if (h.swing === 0) {
      h.swing = SWING_TIME * 2.5;
      h.swingAnim = SWING_TIME;
      const dx = h.target.x + 0.5 - h.x, dy = h.target.y + 0.5 - h.y;
      h.face = Math.abs(dx) > Math.abs(dy) ? { x: Math.sign(dx), y: 0 } : { x: 0, y: Math.sign(dy) || 1 };
      const r = chop(h.target.x, h.target.y, helperTier(), helperDmg(), false);
      if (r !== 'hit') h.target = null;
    }
  } else {
    h.target = null;
  }
}

// ---------------------------------------------------------------------------
// Effects
// ---------------------------------------------------------------------------

function spawnChips(x, y, n) {
  for (let i = 0; i < n; i++) {
    const a = Math.random() * Math.PI * 2;
    const s = 1 + Math.random() * 2.5;
    particles.push({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s - 1.5, life: 0.5 + Math.random() * 0.4, size: 0.05 + Math.random() * 0.06 });
  }
}

function updateEffects(dt) {
  for (let i = particles.length - 1; i >= 0; i--) {
    const p = particles[i];
    p.life -= dt;
    p.vy += 6 * dt;
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    if (p.life <= 0) particles.splice(i, 1);
  }
  for (let i = floaters.length - 1; i >= 0; i--) {
    const f = floaters[i];
    f.life -= dt;
    f.y -= dt * 0.8;
    if (f.life <= 0) floaters.splice(i, 1);
  }
  for (const t of shaking) {
    t.shake -= dt;
    if (t.shake <= 0) { t.shake = 0; shaking.delete(t); }
  }
}
const shaking = new Set();

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');
let zoom = 40; // pixels per tile
let dpr = 1;
const cam = { x: CENTER, y: CENTER };

function resize() {
  dpr = window.devicePixelRatio || 1;
  canvas.width = Math.floor(window.innerWidth * dpr);
  canvas.height = Math.floor(window.innerHeight * dpr);
}
window.addEventListener('resize', resize);

const toScreen = (wx, wy) => [
  (wx - cam.x) * zoom + window.innerWidth / 2,
  (wy - cam.y) * zoom + window.innerHeight / 2,
];
const toWorld = (sx, sy) => [
  (sx - window.innerWidth / 2) / zoom + cam.x,
  (sy - window.innerHeight / 2) / zoom + cam.y,
];

const TREE_COLORS = [
  ['#7fbf4d', '#5f9e36'],
  ['#6fb24a', '#4d8f33'],
  ['#3f7d3a', '#2c5f2a'],
  ['#4e7a2c', '#35591c'],
  ['#2e5a3a', '#1d4029'],
  ['#2a4a30', '#17301c'],
];

function drawTree(x, y, size, t) {
  const h = tileHash(x, y);
  const h2 = tileHash(y + 101, x + 7);
  const shake = t.shake > 0 ? Math.sin(t.shake * 90) * 0.04 : 0;
  const cx = x + 0.5 + (h - 0.5) * 0.25 + shake;
  const cy = y + 0.5 + (h2 - 0.5) * 0.25;
  const r = 0.26 + size * 0.085;
  const [sx, sy] = toScreen(cx, cy);
  const R = r * zoom;
  const [c1, c2] = TREE_COLORS[size];

  // shadow
  ctx.fillStyle = 'rgba(0,0,0,0.22)';
  ctx.beginPath();
  ctx.ellipse(sx + R * 0.15, sy + R * 0.35, R * 0.95, R * 0.55, 0, 0, Math.PI * 2);
  ctx.fill();
  // trunk
  ctx.fillStyle = '#5a3a1e';
  const tw = Math.max(2, zoom * (0.06 + size * 0.025));
  ctx.fillRect(sx - tw / 2, sy - R * 0.1, tw, R * 0.55);
  // canopy
  ctx.fillStyle = c2;
  ctx.beginPath();
  ctx.arc(sx, sy - R * 0.35, R, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = c1;
  ctx.beginPath();
  ctx.arc(sx - R * 0.25, sy - R * 0.55, R * 0.62, 0, Math.PI * 2);
  ctx.fill();

  // health bar when damaged
  if (t.hp < TREES[size].hp) {
    const w = zoom * 0.8, bx = sx - w / 2, by = sy - R * 1.5;
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.fillRect(bx, by, w, 5);
    ctx.fillStyle = '#ffd27a';
    ctx.fillRect(bx, by, w * Math.max(0, t.hp / TREES[size].hp), 5);
  }
}

function drawStump(x, y) {
  const [sx, sy] = toScreen(x + 0.5 + (tileHash(x, y) - 0.5) * 0.25, y + 0.55);
  const r = zoom * 0.14;
  ctx.fillStyle = '#6b4526';
  ctx.beginPath();
  ctx.ellipse(sx, sy, r, r * 0.7, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#c79a62';
  ctx.beginPath();
  ctx.ellipse(sx, sy - r * 0.15, r * 0.75, r * 0.5, 0, 0, Math.PI * 2);
  ctx.fill();
}

function drawBuilding(x, y, id) {
  const [sx, sy] = toScreen(x, y);
  const z = zoom;
  ctx.fillStyle = 'rgba(0,0,0,0.25)';
  ctx.fillRect(sx + z * 0.12, sy + z * 0.25, z * 0.85, z * 0.8);
  if (id === 'workbench') {
    ctx.fillStyle = '#8a5d31';
    ctx.fillRect(sx + z * 0.1, sy + z * 0.35, z * 0.8, z * 0.3);
    ctx.fillStyle = '#5b3b1d';
    ctx.fillRect(sx + z * 0.15, sy + z * 0.65, z * 0.1, z * 0.25);
    ctx.fillRect(sx + z * 0.75, sy + z * 0.65, z * 0.1, z * 0.25);
    ctx.fillStyle = '#aaa';
    ctx.fillRect(sx + z * 0.55, sy + z * 0.28, z * 0.25, z * 0.08);
  } else if (id === 'woodshed' || id === 'lumberyard') {
    const big = id === 'lumberyard';
    ctx.fillStyle = big ? '#6e4924' : '#7a5230';
    ctx.fillRect(sx + z * 0.08, sy + z * 0.3, z * 0.84, z * 0.62);
    // stacked logs
    ctx.fillStyle = '#c79a62';
    const rows = big ? 3 : 2;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < 3; c++) {
        ctx.beginPath();
        ctx.arc(sx + z * (0.28 + c * 0.22), sy + z * (0.8 - r * 0.18), z * 0.085, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.fillStyle = big ? '#3b3b3b' : '#4a2f18';
    ctx.fillRect(sx + z * 0.02, sy + z * 0.18, z * 0.96, z * 0.14);
  } else if (id === 'cabin') {
    ctx.fillStyle = '#8a5d31';
    ctx.fillRect(sx + z * 0.1, sy + z * 0.4, z * 0.8, z * 0.55);
    ctx.strokeStyle = '#5b3b1d';
    ctx.lineWidth = Math.max(1, z * 0.03);
    for (let i = 1; i < 4; i++) {
      ctx.beginPath();
      ctx.moveTo(sx + z * 0.1, sy + z * (0.4 + i * 0.14));
      ctx.lineTo(sx + z * 0.9, sy + z * (0.4 + i * 0.14));
      ctx.stroke();
    }
    ctx.fillStyle = '#7a2e22';
    ctx.beginPath();
    ctx.moveTo(sx + z * 0.0, sy + z * 0.45);
    ctx.lineTo(sx + z * 0.5, sy + z * 0.02);
    ctx.lineTo(sx + z * 1.0, sy + z * 0.45);
    ctx.fill();
    ctx.fillStyle = '#3a2412';
    ctx.fillRect(sx + z * 0.42, sy + z * 0.65, z * 0.18, z * 0.3);
    ctx.fillStyle = '#ffd27a';
    ctx.fillRect(sx + z * 0.18, sy + z * 0.55, z * 0.14, z * 0.12);
  } else if (id === 'sawmill') {
    ctx.fillStyle = '#6b6b6b';
    ctx.fillRect(sx + z * 0.05, sy + z * 0.35, z * 0.9, z * 0.58);
    ctx.fillStyle = '#4a4a4a';
    ctx.fillRect(sx + z * 0.02, sy + z * 0.25, z * 0.96, z * 0.14);
    ctx.fillStyle = '#d9d9d9';
    ctx.beginPath();
    ctx.arc(sx + z * 0.5, sy + z * 0.64, z * 0.2, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#6b6b6b';
    ctx.beginPath();
    ctx.arc(sx + z * 0.5, sy + z * 0.64, z * 0.06, 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawPerson(e, shirt, hat) {
  const bob = Math.sin(e.walkAnim || 0) * 0.03;
  const [sx, sy] = toScreen(e.x, e.y + bob);
  const z = zoom;
  ctx.fillStyle = 'rgba(0,0,0,0.25)';
  ctx.beginPath();
  ctx.ellipse(sx, sy + z * 0.28, z * 0.22, z * 0.09, 0, 0, Math.PI * 2);
  ctx.fill();
  // body
  ctx.fillStyle = shirt;
  ctx.beginPath();
  ctx.ellipse(sx, sy + z * 0.05, z * 0.2, z * 0.24, 0, 0, Math.PI * 2);
  ctx.fill();
  // head
  ctx.fillStyle = '#f0c8a0';
  ctx.beginPath();
  ctx.arc(sx, sy - z * 0.25, z * 0.14, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = hat;
  ctx.beginPath();
  ctx.arc(sx, sy - z * 0.3, z * 0.14, Math.PI, 0);
  ctx.fill();

  // tool, swinging toward the facing direction
  const f = e.face || { x: 0, y: 1 };
  const base = Math.atan2(f.y, f.x);
  const swingT = e.swingAnim > 0 ? e.swingAnim / SWING_TIME : 0;
  const ang = base - 0.9 + (1 - swingT) * 1.8 * (swingT > 0 ? 1 : 0.5);
  const hx = sx + Math.cos(ang) * z * 0.22, hy = sy + Math.sin(ang) * z * 0.22;
  const tx = sx + Math.cos(ang) * z * 0.45, ty = sy + Math.sin(ang) * z * 0.45;
  ctx.strokeStyle = '#6b4526';
  ctx.lineWidth = Math.max(2, z * 0.05);
  ctx.beginPath(); ctx.moveTo(hx, hy); ctx.lineTo(tx, ty); ctx.stroke();
  ctx.fillStyle = '#c9c9c9';
  ctx.beginPath(); ctx.arc(tx, ty, z * 0.06, 0, Math.PI * 2); ctx.fill();
}

let hoverTile = null;

function render() {
  const W = window.innerWidth, H = window.innerHeight;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = '#0d1a0f';
  ctx.fillRect(0, 0, W, H);

  const [wx0, wy0] = toWorld(0, 0);
  const [wx1, wy1] = toWorld(W, H);
  const x0 = Math.max(0, Math.floor(wx0) - 1), y0 = Math.max(0, Math.floor(wy0) - 1);
  const x1 = Math.min(MAP - 1, Math.ceil(wx1) + 1), y1 = Math.min(MAP - 1, Math.ceil(wy1) + 2);

  // ground
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const t = tiles[y * MAP + x];
      const [sx, sy] = toScreen(x, y);
      const h = tileHash(x, y);
      if (t.tree >= 0) ctx.fillStyle = h < 0.5 ? '#1f3a1d' : '#223f1f';
      else ctx.fillStyle = h < 0.33 ? '#6f9a45' : h < 0.66 ? '#6a9542' : '#74a049';
      ctx.fillRect(sx, sy, zoom + 1, zoom + 1);
      if (t.tree < 0 && h > 0.85) {
        // little grass tufts
        ctx.fillStyle = '#5d8a39';
        ctx.fillRect(sx + zoom * 0.3, sy + zoom * 0.6, zoom * 0.05, zoom * 0.12);
        ctx.fillRect(sx + zoom * 0.38, sy + zoom * 0.55, zoom * 0.05, zoom * 0.17);
      }
    }
  }

  // build placement preview
  if (buildMode && hoverTile) {
    const ok = canPlace(hoverTile.x, hoverTile.y);
    const [sx, sy] = toScreen(hoverTile.x, hoverTile.y);
    ctx.fillStyle = ok ? 'rgba(255,210,122,0.35)' : 'rgba(255,90,70,0.35)';
    ctx.fillRect(sx, sy, zoom, zoom);
  }

  // objects, row by row so things further down draw on top
  const ents = [...helpers.map(h => [h, '#3b6ea8', '#27496f']), [player, '#b8332b', '#7a1f1a']];
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const t = tiles[y * MAP + x];
      if (t.tree >= 0) drawTree(x, y, t.tree, t);
      else if (t.building) drawBuilding(x, y, t.building);
      else if (t.stump) drawStump(x, y);
    }
    for (const [e, shirt, hat] of ents) if (Math.floor(e.y) === y) drawPerson(e, shirt, hat);
  }

  // effects
  ctx.fillStyle = '#c79a62';
  for (const p of particles) {
    const [sx, sy] = toScreen(p.x, p.y);
    ctx.globalAlpha = Math.min(1, p.life * 2);
    ctx.fillRect(sx, sy, p.size * zoom, p.size * zoom);
  }
  ctx.globalAlpha = 1;
  ctx.font = `bold ${Math.max(12, zoom * 0.4)}px system-ui, sans-serif`;
  ctx.textAlign = 'center';
  for (const f of floaters) {
    const [sx, sy] = toScreen(f.x, f.y);
    ctx.globalAlpha = Math.min(1, f.life);
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.fillText(f.text, sx + 1, sy + 1);
    ctx.fillStyle = f.color;
    ctx.fillText(f.text, sx, sy);
  }
  ctx.globalAlpha = 1;

  // darken toward screen edges for a cozy forest feel
  const g = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.35, W / 2, H / 2, Math.max(W, H) * 0.75);
  g.addColorStop(0, 'rgba(0,0,0,0)');
  g.addColorStop(1, 'rgba(0,0,0,0.45)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
}

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

const keys = new Set();
let buildMode = null;

window.addEventListener('keydown', e => {
  if (e.code === 'Escape') { setBuildMode(null); return; }
  if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) e.preventDefault();
  keys.add(e.code);
});
window.addEventListener('keyup', e => keys.delete(e.code));
window.addEventListener('blur', () => keys.clear());

function pointerTile(e) {
  const [wx, wy] = toWorld(e.clientX, e.clientY);
  return { x: Math.floor(wx), y: Math.floor(wy) };
}

canvas.addEventListener('pointermove', e => { hoverTile = pointerTile(e); });

canvas.addEventListener('pointerdown', e => {
  const { x, y } = pointerTile(e);
  hoverTile = { x, y };
  if (!inBounds(x, y)) return;
  const t = tileAt(x, y);

  if (buildMode) {
    placeBuilding(x, y);
    return;
  }

  const px = Math.floor(player.x), py = Math.floor(player.y);
  if (t.tree >= 0) {
    if (t.tree > state.tool) { tooBig(x, y); return; }
    player.target = { x, y };
    if (inReach(player.x, player.y, x, y)) { player.path = null; return; }
    const path = findPath(px, py, (cx, cy) => inReach(cx + 0.5, cy + 0.5, x, y));
    if (path) player.path = path;
    else { player.target = null; toast("You can't reach that tree yet."); }
  } else if (walkable(x, y)) {
    player.target = null;
    player.path = findPath(px, py, (cx, cy) => cx === x && cy === y);
  }
});

canvas.addEventListener('wheel', e => {
  e.preventDefault();
  zoom = Math.max(18, Math.min(80, zoom * (e.deltaY > 0 ? 0.9 : 1.1)));
}, { passive: false });

// ---------------------------------------------------------------------------
// Building & crafting
// ---------------------------------------------------------------------------

function canPlace(x, y) {
  if (!walkable(x, y)) return false;
  // don't build on top of anyone
  const occupied = e => Math.floor(e.x) === x && Math.floor(e.y) === y;
  return !occupied(player) && !helpers.some(occupied);
}

function setBuildMode(id) {
  buildMode = id;
  refreshUI();
}

function placeBuilding(x, y) {
  const b = BUILDINGS[buildMode];
  if (!canPlace(x, y)) { toast('You need an open, cleared spot to build.'); return; }
  if (state.wood < b.cost) { toast(`Not enough wood for a ${b.name}.`); setBuildMode(null); return; }
  state.wood -= b.cost;
  tileAt(x, y).building = buildMode;
  tileAt(x, y).stump = false;
  toast(`Built a ${b.name}!`);
  if (buildMode === 'cabin') { spawnHelper(x, y); toast('A lumberjack has moved into the cabin.'); }
  // Invalidate any paths going through the new building.
  for (const e of [player, ...helpers]) e.path = null;
  if (b.unique || state.wood < b.cost) setBuildMode(null);
  else refreshUI();
  saveGame();
}

function buyTool(i) {
  const tool = TOOLS[i];
  if (i !== state.tool + 1 || state.wood < tool.cost) return;
  if (tool.needs && countBuildings(tool.needs) === 0) return;
  state.wood -= tool.cost;
  state.tool = i;
  toast(`Crafted a ${tool.name}! You can now cut ${TREES[i].name} trees.`);
  refreshUI();
  saveGame();
}

// ---------------------------------------------------------------------------
// UI
// ---------------------------------------------------------------------------

const $ = id => document.getElementById(id);

function toast(msg) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  $('toasts').appendChild(el);
  while ($('toasts').children.length > 3) $('toasts').firstChild.remove();
  setTimeout(() => el.remove(), 3200);
}

function refreshUI() {
  const cap = woodCap();
  $('wood').textContent = state.wood;
  $('cap').textContent = cap;
  $('wood').parentElement.classList.toggle('full', state.wood >= cap);
  $('tool').textContent = TOOLS[state.tool].name;
  $('clearing').textContent = clearingSize();
  $('felled').textContent = state.felled;
  $('helpers').textContent = helpers.length;
  $('helpers-stat').hidden = helpers.length === 0;

  // tools: show the next one to craft
  const tools = $('tools');
  tools.innerHTML = '';
  const next = state.tool + 1;
  if (next < TOOLS.length) {
    const t = TOOLS[next];
    const missing = t.needs && countBuildings(t.needs) === 0;
    const overCap = t.cost > cap;
    const btn = document.createElement('button');
    btn.className = 'item';
    btn.disabled = missing || state.wood < t.cost;
    btn.innerHTML = `<span class="cost">${t.cost} wood</span><span class="name">${t.name}</span>
      <span class="desc">${t.desc}</span>
      ${missing ? `<span class="req">Requires a ${BUILDINGS[t.needs].name}</span>` : ''}
      ${!missing && overCap ? `<span class="req">Need more storage (cap ${cap})</span>` : ''}`;
    btn.onclick = () => buyTool(next);
    tools.appendChild(btn);
  } else {
    tools.innerHTML = '<p class="hint">You have the best tool there is.</p>';
  }

  // buildings
  const bl = $('buildings');
  bl.innerHTML = '';
  for (const [id, b] of Object.entries(BUILDINGS)) {
    const owned = countBuildings(id);
    if (b.unique && owned) continue;
    const btn = document.createElement('button');
    btn.className = 'item' + (buildMode === id ? ' active' : '');
    btn.disabled = state.wood < b.cost && buildMode !== id;
    btn.innerHTML = `<span class="cost">${b.cost} wood</span><span class="name">${b.name}${owned ? ` ×${owned}` : ''}</span>
      <span class="desc">${b.desc}</span>`;
    btn.onclick = () => setBuildMode(buildMode === id ? null : id);
    bl.appendChild(btn);
  }
  $('build-hint').textContent = buildMode
    ? `Click a cleared tile to place your ${BUILDINGS[buildMode].name}. Esc to cancel.`
    : '';
}

$('panel-toggle').onclick = () => $('panel').classList.toggle('closed');
if (window.innerWidth < 600) $('panel').classList.add('closed');

let resetArmed = null;
$('reset').onclick = () => {
  // Two clicks to reset (browser confirm dialogs aren't available everywhere).
  if (!resetArmed) {
    $('reset').textContent = 'Click again to start over';
    resetArmed = setTimeout(() => { resetArmed = null; $('reset').textContent = 'Reset game'; }, 3000);
    return;
  }
  clearTimeout(resetArmed);
  resetArmed = null;
  $('reset').textContent = 'Reset game';
  try { localStorage.removeItem(SAVE_KEY); } catch (e) { /* ignore */ }
  newGame();
  player.x = state.player.x; player.y = state.player.y;
  player.path = null; player.target = null;
  buildMode = null;
  refreshUI();
  toast('A new clearing in a vast forest. Grab your pocket knife.');
};

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------

let last = performance.now();
let saveTimer = 0;
let uiTimer = 0;

function frame(now) {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;

  updatePlayer(dt);
  for (const h of helpers) updateHelper(h, dt);
  updateEffects(dt);

  // camera eases toward the player
  cam.x += (player.x - cam.x) * Math.min(1, dt * 8);
  cam.y += (player.y - cam.y) * Math.min(1, dt * 8);

  render();

  uiTimer += dt;
  if (uiTimer > 0.25) { uiTimer = 0; refreshWood(); }
  saveTimer += dt;
  if (saveTimer > 5) { saveTimer = 0; saveGame(); }

  requestAnimationFrame(frame);
}

// Cheap per-frame HUD update (full refresh happens on events).
let lastWood = -1;
function refreshWood() {
  if (state.wood !== lastWood) { lastWood = state.wood; refreshUI(); }
}

window.addEventListener('beforeunload', saveGame);
document.addEventListener('visibilitychange', () => { if (document.hidden) saveGame(); });

resize();
const loaded = loadGame();
if (!loaded) newGame();
player.x = state.player.x;
player.y = state.player.y;
cam.x = player.x; cam.y = player.y;
refreshUI();
toast(loaded ? 'Welcome back to Wood World.' : 'A small clearing in a vast forest. All you have is a pocket knife…');
requestAnimationFrame(frame);
