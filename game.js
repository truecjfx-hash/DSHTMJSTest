/* ============================================================
   墨迹成行 · Ink Drift
   一个滑行成画的小游戏。
   规则：棋子朝一个方向一直滑到撞墙为止，沿途每一格都会染墨，
        把整张棋盘的浅色格子涂满即过关。步数越少，评价越高。

   纯手写 JS，无任何依赖。核心逻辑（滑行 / 求解 / 关卡生成）
   与渲染分离，方便 tests/verify.js 在 Node 里直接跑。
   ============================================================ */
(function () {
  'use strict';

  const SVGNS = 'http://www.w3.org/2000/svg';
  const COLS_HARDCODED = 12;

  /* ==========================================================
     一、关卡数据
     ========================================================== */

  // 每关：w/h 尺寸，(x, y) 坐标，y 向下。p = 目标格，player = 起点。
  // min 由内置求解器自动算出，无需手填。
  const LEVELS = [
    { name: '起笔', w: 6, h: 6,
      walls: ['0,0', '1,1', '4,4', '5,0'],
      player: [2, 2],
      goals: [[0, 1], [0, 3], [3, 5], [0, 2], [3, 0], [5, 5], [2, 5]] },

    { name: '十字', w: 6, h: 6,
      walls: ['2,2', '3,2', '2,3', '3,3'],
      player: [0, 0],
      goals: [[5, 1], [0, 2], [2, 5], [0, 3], [3, 0], [5, 0]] },

    { name: '两扇门', w: 6, h: 6,
      walls: ['2,0', '3,0', '2,1', '3,1', '2,4', '3,4', '2,5', '3,5'],
      player: [0, 2],
      goals: [[0, 3], [3, 2], [2, 2], [0, 0], [1, 0], [1, 5], [0, 2], [1, 2]] },

    // —— 下面几关的墙体由 tools/find-seeds.js 搜出的种子确定性生成，
    //    比手写布局做得更深（手写的最多只能做到 4 步） ——
    { name: '回廊', derived: { seed: 25, size: 6, walk: 10 } },

    { name: '横竖之间', w: 6, h: 6,
      walls: ['2,2', '2,3', '3,2', '3,3', '0,1', '5,4', '1,5'],
      player: [2, 0],
      goals: [[4, 5], [5, 1], [0, 2], [5, 5], [3, 0], [2, 5], [3, 4], [4, 0], [0, 4]] },

    { name: '四角', w: 7, h: 7,
      walls: ['3,2', '4,2', '2,3', '2,4', '3,5', '4,5'],
      player: [3, 3],
      goals: [[6, 1], [5, 3], [3, 0], [2, 0], [2, 2], [6, 3], [1, 6], [1, 3], [0, 3]] },

    { name: '阶梯', derived: { seed: 80, size: 7, walk: 12 } },

    { name: '画框', w: 7, h: 7,
      walls: ['1,1', '5,1', '1,5', '5,5', '3,3', '3,0', '3,6'],
      player: [0, 3],
      goals: [[4, 0], [3, 1], [1, 0], [6, 6], [6, 4], [6, 5], [5, 6], [5, 3], [0, 6]] },

    { name: '对折', derived: { seed: 118, size: 7, walk: 12 } },

    { name: '一线天', derived: { seed: 57, size: 8, walk: 14 } },

    { name: '碎格', derived: { seed: 207, size: 8, walk: 14 } },

    { name: '收笔', w: 8, h: 8,
      walls: ['2,2', '3,2', '4,2', '2,3', '4,3', '2,4', '3,4', '4,4',
              '0,3', '7,4', '3,0', '4,7', '6,6', '1,1'],
      player: [0, 0],
      goals: [[7, 3], [1, 3], [2, 7], [6, 0], [3, 5], [5, 3], [3, 3], [7, 1], [0, 1]] }
  ];

  // 每关的墨色 / 涟漪色（循环使用）
  const PALETTE = [
    ['#1f4d7a', '#db9c3c'], // 群青
    ['#2f6b5f', '#e0a94a'], // 松绿
    ['#6b3350', '#e6b45c'], // 紫檀
    ['#2b3f6b', '#d98f4a'], // 夜蓝
    ['#7a4620', '#e8c477'], // 赭石
    ['#3f5d33', '#ddb257'], // 苔青
    ['#5b3a6b', '#e5a2c0'], // 藕紫
    ['#1d5c66', '#f0c05a']  // 石青
  ];

  /* ==========================================================
     二、纯逻辑：坐标、滑行、求解、生成
     ========================================================== */

  const key = (x, y) => x + ',' + y;

  const DIRS = {
    up:    [0, -1],
    down:  [0, 1],
    left:  [-1, 0],
    right: [1, 0]
  };

  /** 从 (x,y) 朝方向滑行，返回沿途经过的格子（含起点）。
   *  规则：遇到墙就「贴上去」——墙体本身也在棋盘内，所以棋子会停在墙上，
   *  于是棋盘内任何一格都可以成为落脚点，关卡的解法空间更大也更有趣。 */
  function simulate(level, x, y, dir) {
    const d = DIRS[dir];
    if (!d) throw new Error('unknown direction: ' + dir);
    const [dx, dy] = d;
    const cells = [[x, y]];
    let cx = x, cy = y;
    for (let guard = 0; guard <= level.w + level.h; guard++) {
      const nx = cx + dx, ny = cy + dy;
      if (nx < 0 || ny < 0 || nx >= level.w || ny >= level.h) break;
      cx = nx; cy = ny;
      if (level.walls.has(key(cx, cy))) break; // 撞上墙，停在墙上
      cells.push([cx, cy]);
    }
    return { cells, end: [cx, cy], moved: cells.length > 1 };
  }

  /** BFS 求最短通关步数；返回 { moves, path } 或 null */
  function solve(level, cap) {
    const w = level.w, h = level.h;
    const goals = level.goals;
    const gIndex = new Map();
    goals.forEach((g, i) => gIndex.set(key(g[0], g[1]), i));
    const full = (1 << goals.length) - 1;

    const startIdx = (() => {
      let m = 0;
      const i = gIndex.get(key(level.player[0], level.player[1]));
      if (i !== undefined) m |= (1 << i);
      return m;
    })();

    const pack = (x, y, mask) => ((y * w + x) << goals.length) | mask;
    const start = pack(level.player[0], level.player[1], startIdx);
    if (startIdx === full) return { moves: 0, path: [] };

    const from = new Map([[start, null]]);
    let frontier = [[level.player[0], level.player[1], startIdx]];
    let depth = 0;
    const limit = cap || Math.max(12, w * h);

    while (frontier.length && depth < limit) {
      const next = [];
      for (const [x, y, mask] of frontier) {
        for (const dir of Object.keys(DIRS)) {
          const sim = simulate(level, x, y, dir);
          if (!sim.moved) continue;
          let nm = mask;
          for (const [cx, cy] of sim.cells) {
            const gi = gIndex.get(key(cx, cy));
            if (gi !== undefined) nm |= (1 << gi);
          }
          const state = pack(sim.end[0], sim.end[1], nm);
          if (from.has(state)) continue;
          from.set(state, { px: x, py: y, pm: mask, dir });
          if (nm === full) return { moves: depth + 1, path: tracePath(from, state, pack) };
          next.push([sim.end[0], sim.end[1], nm]);
        }
      }
      frontier = next;
      depth++;
    }
    return null;
  }

  function tracePath(from, state, pack) {
    const path = [];
    let cur = state;
    while (true) {
      const p = from.get(cur);
      if (!p) break;
      path.push(p.dir);
      cur = pack(p.px, p.py, p.pm);
    }
    return path.reverse();
  }

  /** 把 solve() 给出的方向序列还原成每一步经过的格子 */
  function replayPath(level, dirs) {
    const out = [];
    let x = level.player[0], y = level.player[1];
    for (const dir of dirs) {
      const sim = simulate(level, x, y, dir);
      out.push({ dir, cells: sim.cells });
      x = sim.end[0]; y = sim.end[1];
    }
    return out;
  }

  /** 从步数推出评价（无限步数也能通关，只有星级会掉）
   *  ★★★ 达到理论最少步数；★★ 接近；其余 ★（通关即可） */
  function starsFor(moves, min) {
    if (!min || min <= 0) return 3;
    if (moves <= min) return 3;
    if (moves <= Math.ceil(min * 1.5) + 2) return 2;
    return 1;
  }

  /* 把标记了 derived 的关卡用生成器展开成普通关卡数据。
     种子固定 => 每次打开都是同一张棋盘，但布局比手写的有深度。 */
  LEVELS.forEach((entry, i) => {
    if (!entry.derived) return;
    const d = entry.derived;
    const gen = genLevel(d.seed, d.size, d.walk);
    if (!gen) {
      console.warn('[墨迹成行] 生成第' + (i + 1) + '关失败，种子 ' + d.seed);
      return;
    }
    entry.w = gen.w;
    entry.h = gen.h;
    entry.player = gen.player;
    entry.goals = gen.goals;
    entry.walls = Array.from(gen.walls);
    entry.min = gen.min;
    entry.solution = gen.solution;
    entry.generated = true;
  });

  function inkFor(index) {
    const [main, ripple] = PALETTE[((index % PALETTE.length) + PALETTE.length) % PALETTE.length];
    return { main, ripple };
  }

  /* ---- 无尽模式 / 后期关卡：随机生成一张必然可解的棋盘 ----
     做法：先用随机滑行「走」出一条路径，再把路径没碰过的格子全变成墙，
     于是这条路径本身就是一个合法解 -> 保证有解。
     walkLen 越大，走廊越长、墙越密，最优解通常也越深。 */
  function genLevel(seed, size, walkLen) {
    const n = size || 8;
    const steps = walkLen || 7;
    const R = mulberry32(seed);
    const keySet = new Set();
    for (let attempt = 0; attempt < 400; attempt++) {
      const walls = new Set();
      // 随机撒一些墙，制造拐弯
      const sprinkles = Math.floor(n * 0.7);
      for (let i = 0; i < sprinkles; i++) {
        const x = 1 + Math.floor(R() * (n - 2));
        const y = 1 + Math.floor(R() * (n - 2));
        walls.add(key(x, y));
      }
      const dirNames = Object.keys(DIRS);
      let x = Math.floor(R() * n), y = Math.floor(R() * n);
      if (walls.has(key(x, y))) continue;

      const level0 = { w: n, h: n, walls, player: [x, y], goals: [] };
      const visited = [key(x, y)];
      const seen = new Set(visited);
      let moves = 0;
      for (let step = 0; step < steps; step++) {
        const dir = dirNames[Math.floor(R() * 4)];
        const sim = simulate(level0, x, y, dir);
        if (!sim.moved) continue;
        moves++;
        for (const [cx, cy] of sim.cells) {
          const k = key(cx, cy);
          if (!seen.has(k)) { seen.add(k); visited.push(k); }
        }
        x = sim.end[0]; y = sim.end[1];
      }
      if (moves < 3 || visited.length < n) continue;

      // 路径没碰过的格子全部变墙（把棋盘收成一条「走廊」）
      const walls2 = new Set();
      for (let cy = 0; cy < n; cy++) {
        for (let cx = 0; cx < n; cx++) {
          if (!seen.has(key(cx, cy))) walls2.add(key(cx, cy));
        }
      }
      // 目标池打乱后取一部分，保证有解；目标越多越耐玩
      const pool = shuffle(visited.slice(), R);
      const goalCount = Math.min(pool.length, 5 + Math.floor(R() * 4));
      const goals = pool.slice(0, goalCount).map((k) => k.split(',').map(Number));
      const start = visited[0].split(',').map(Number);
      const level = { name: '即兴', w: n, h: n, walls: walls2, player: start, goals };
      const sol = solve(level, 20);
      if (sol && sol.moves >= 3) {
        level.min = sol.moves;
        level.solution = sol.path;
        level.seed = seed;
        return level;
      }
    }
    return null;
  }

  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function shuffle(arr, R) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(R() * (i + 1));
      const t = arr[i]; arr[i] = arr[j]; arr[j] = t;
    }
    return arr;
  }

  /* ---- 关卡归一化 + 数据自检（控制台会打印问题） ---- */
  function normalizeLevel(raw) {
    return {
      name: raw.name || '—',
      w: raw.w, h: raw.h,
      walls: new Set(raw.walls || []),
      player: raw.player.slice(),
      goals: raw.goals.map((g) => g.slice()),
      min: raw.min, solution: raw.solution, seed: raw.seed
    };
  }

  function lintLevels() {
    const problems = [];
    LEVELS.forEach((raw, i) => {
      const L = normalizeLevel(raw);
      const tag = '第' + (i + 1) + '关<' + L.name + '>';
      if (!(L.w > 0 && L.h > 0)) problems.push(tag + ' 尺寸非法');
      const inB = (p) => p[0] >= 0 && p[1] >= 0 && p[0] < L.w && p[1] < L.h;
      if (!inB(L.player)) problems.push(tag + ' 起点出界');
      if (L.walls.has(key(L.player[0], L.player[1]))) problems.push(tag + ' 起点落在墙里');
      for (const p of L.goals) {
        if (!inB(p)) { problems.push(tag + ' 目标出界 ' + p); continue; }
        if (L.walls.has(key(p[0], p[1]))) problems.push(tag + ' 目标在墙里 ' + p);
      }
      const dup = new Set();
      for (const p of L.goals) {
        if (dup.has(key(p[0], p[1]))) problems.push(tag + ' 目标重复 ' + p);
        dup.add(key(p[0], p[1]));
      }
      if (L.walls.has(key(L.player[0], L.player[1]))) problems.push(tag + ' 起点与目标冲突');
      if (!L.goals.length) problems.push(tag + ' 没有目标');
    });
    return problems;
  }

  // 计算最优步数（有解则写入 min / solution）
  LEVELS.forEach((raw) => {
    const L = normalizeLevel(raw);
    const sol = solve(L, 16);
    if (sol) { raw.min = sol.moves; raw.solution = sol.path; }
  });
  const LINT = lintLevels();

  /* ==========================================================
     三、存档
     ========================================================== */

  const STORE_KEY = 'ink-drift.save.v1';

  function loadSave() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (!raw) return {};
      const obj = JSON.parse(raw);
      return obj && typeof obj === 'object' ? obj : {};
    } catch (e) { return {}; }
  }

  function persist() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(state.save)); } catch (e) { /* 隐私模式忽略 */ }
  }

  /* ==========================================================
     四、音效（极简 WebAudio，首次交互后才创建）
     ========================================================== */

  const Audio_ = {
    ctx: null,
    enabled: true,
    ensure() {
      if (!this.enabled) return null;
      if (!this.ctx) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return null;
        try { this.ctx = new AC(); } catch (e) { return null; }
      }
      if (this.ctx.state === 'suspended') this.ctx.resume();
      return this.ctx;
    },
    tone(freq, dur, type, gain, delay) {
      const ctx = this.ensure();
      if (!ctx) return;
      const t0 = ctx.currentTime + (delay || 0);
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.type = type || 'triangle';
      osc.frequency.setValueAtTime(freq, t0);
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(gain || 0.06, t0 + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      osc.connect(g).connect(ctx.destination);
      osc.start(t0);
      osc.stop(t0 + dur + 0.02);
    },
    slide() { this.tone(150, 0.16, 'sine', 0.05); },
    paint(steps) {
      const n = Math.min(3, 1 + Math.floor(steps / 2));
      for (let i = 0; i < n; i++) this.tone(420 + i * 150, 0.09, 'triangle', 0.035, i * 0.05);
    },
    bump() { this.tone(72, 0.09, 'square', 0.035); },
    win() { [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => this.tone(f, 0.34, 'sine', 0.05, i * 0.1)); }
  };

  /* ==========================================================
     五、通用小工具
     ========================================================== */

  function el(id) { return document.getElementById(id); }

  function starString(n) {
    return '★★★'.slice(0, n) + '☆☆☆'.slice(0, 3 - n);
  }

  function hexA(hex, alpha) {
    const h = hex.replace('#', '');
    const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
    const r = parseInt(full.slice(0, 2), 16) || 0;
    const g = parseInt(full.slice(2, 4), 16) || 0;
    const b = parseInt(full.slice(4, 6), 16) || 0;
    return 'rgba(' + r + ',' + g + ',' + b + ',' + alpha + ')';
  }

  function svg(tag, attrs) {
    const node = document.createElementNS(SVGNS, tag);
    if (attrs) for (const k in attrs) node.setAttribute(k, attrs[k]);
    return node;
  }

  function svgText(x, y, str, cls) {
    const t = svg('text', {
      x: x, y: y, 'text-anchor': 'middle', 'dominant-baseline': 'central',
      'font-size': 26, 'font-family': 'Songti SC, SimSun, Georgia, serif',
      fill: '#8a7a5f', opacity: '0.45'
    });
    if (cls) t.setAttribute('class', cls);
    t.textContent = str;
    return t;
  }

  /** 把某个目标格的编号抹掉（涂满之后就不需要提示了） */
  function clearGoalNumber(k) {
    const node = state.numNodes && state.numNodes.get(k);
    if (!node) return;
    if (node.parentNode) node.parentNode.removeChild(node);
    state.numNodes.delete(k);
  }

  /* ==========================================================
     六、游戏状态与渲染
     ========================================================== */

  const state = {
    level: null,
    levelIndex: 0,      // 0..11 为固定关卡，-1 表示无尽即兴局
    moves: 0,
    painted: new Set(),
    undoStack: [],
    locked: false,
    animating: false,
    solved: false,
    showSolution: false,
    cellNodes: new Map(),
    numberLayer: null,
    numNodes: new Map(),
    origin: [0, 0],
    rippleTimers: [],
    raf: null,
    settleTimer: null,
    pos: { x: 0, y: 0 },      // 当前渲染坐标（格，可为小数 = 动画中）
    save: loadSave(),
    endlessSeed: 0,
    endlessSolution: null
  };

  let ui = {};

  /* ---- 渲染整张棋盘 ---- */
  function renderLevel() {
    const L = state.level;
    const svgRoot = ui.svg;

    // 清掉上一关残留的动画计时器
    state.rippleTimers.forEach((id) => clearTimeout(id));
    state.rippleTimers = [];
    if (state.raf) { cancelAnimationFrame(state.raf); state.raf = null; }
    if (state.settleTimer) { clearTimeout(state.settleTimer); state.settleTimer = null; }
    state.animating = false;

    const ink = inkFor(state.levelIndex >= 0 ? state.levelIndex : state.endlessSeed);
    svgRoot.style.setProperty('--ink-main', ink.main);
    svgRoot.style.setProperty('--ink-ripple', ink.ripple);

    const n = Math.max(L.w, L.h);
    const span = n * 48 + 30;
    const originX = span - (L.w * 48 + 15);
    const originY = span - (L.h * 48 + 15);
    state.origin = [originX, originY];

    svgRoot.setAttribute('viewBox', '0 0 ' + span + ' ' + span);
    while (svgRoot.firstChild) svgRoot.removeChild(svgRoot.firstChild);

    // defs：纸纹 + 斜向影线
    const defs = svg('defs');
    const paperGrad = svg('linearGradient', { id: 'paperGrad', x1: '0', y1: '0', x2: '.4', y2: '1' });
    paperGrad.appendChild(svg('stop', { offset: '0', 'stop-color': '#f7f2e7' }));
    paperGrad.appendChild(svg('stop', { offset: '1', 'stop-color': '#e7dfcd' }));
    defs.appendChild(paperGrad);

    const hatch = svg('pattern', {
      id: 'hatch', width: '7', height: '7', patternUnits: 'userSpaceOnUse',
      patternTransform: 'rotate(45)'
    });
    hatch.appendChild(svg('rect', { width: '7', height: '7', fill: '#1a2530' }));
    hatch.appendChild(svg('line', { x1: '0', y1: '0', x2: '0', y2: '7', stroke: '#ffffff', 'stroke-opacity': '.05', 'stroke-width': '3' }));
    defs.appendChild(hatch);

    const soft = svg('radialGradient', { id: 'softGlow' });
    soft.appendChild(svg('stop', { offset: '0', 'stop-color': hexA(ink.ripple, 0.55) }));
    soft.appendChild(svg('stop', { offset: '1', 'stop-color': hexA(ink.ripple, 0) }));
    defs.appendChild(soft);
    svgRoot.appendChild(defs);

    svgRoot.appendChild(svg('rect', { width: span, height: span, fill: 'url(#paperGrad)' }));

    // 坐标针脚
    const pins = svg('g', { opacity: '.5' });
    for (let x = 0; x < L.w; x++) pins.appendChild(svg('circle', { cx: originX + x * 48 + 24, cy: originY - 8, r: 1.6, fill: '#a8804a' }));
    for (let y = 0; y < L.h; y++) pins.appendChild(svg('circle', { cx: originX - 8, cy: originY + y * 48 + 24, r: 1.6, fill: '#a8804a' }));
    svgRoot.appendChild(pins);

    // 格子层
    const gCells = svg('g', { id: 'cells' });
    state.cellNodes = new Map();

    for (let y = 0; y < L.h; y++) {
      for (let x = 0; x < L.w; x++) {
        const px = originX + x * 48 + 5;
        const py = originY + y * 48 + 5;
        const k = key(x, y);
        const p = [x, y];

        if (L.walls.has(k)) {
          gCells.appendChild(svg('rect', {
            x: px + 1.2, y: py + 1.2, width: 45.6, height: 45.6, rx: 7,
            fill: 'url(#hatch)', stroke: '#0f1720', 'stroke-width': '1.2'
          }));
          continue;
        }

        const goal = L.goals.some((g) => g[0] === x && g[1] === y);
        gCells.appendChild(svg('rect', {
          x: px, y: py, width: 48, height: 48, rx: 8,
          fill: goal ? '#dccdb2' : '#eee6d6',
          stroke: goal ? '#c0a87f' : 'rgba(140,120,90,.28)',
          'stroke-width': goal ? '1.6' : '1'
        }));

        if (goal) {
          gCells.appendChild(svg('rect', {
            x: px + 2.4, y: py + 2.4, width: 43.2, height: 43.2, rx: 6.4,
            fill: 'none', stroke: '#b99a63', 'stroke-width': '1', 'stroke-dasharray': '4 3.5', opacity: '.8'
          }));
        }

        const tile = svg('rect', {
          x: px, y: py, width: 48, height: 48, rx: 8, fill: ink.main, opacity: '0',
          'class': 'tile'
        });
        tile.dataset.key = k;
        gCells.appendChild(tile);
        state.cellNodes.set(k, tile);
      }
    }
    svgRoot.appendChild(gCells);

    // 笔迹层：一条折线 + 圆头，看起来像一笔扫过
    const existing = state.strokeLine;
    if (existing && existing.parentNode) existing.parentNode.removeChild(existing);
    const line = svg('polyline', {
      'stroke-linecap': 'round', 'stroke-linejoin': 'round',
      fill: 'none', stroke: hexA(ink.main, 0.75), 'stroke-width': '15'
    });
    line.style.opacity = '.58';
    svgRoot.appendChild(line);
    state.strokeLine = line;

    // 涟漪层（铺在笔迹之上，装饰用）
    const gRipples = svg('g', { id: 'ripples' });
    svgRoot.appendChild(gRipples);
    state.rippleLayer = gRipples;

    // 目标序号（涂满后会被 clearGoalNumber 抹掉）
    const gNums = svg('g', { id: 'nums' });
    state.numberLayer = gNums;
    state.numNodes = new Map();
    L.goals.forEach((g, i) => {
      const k = key(g[0], g[1]);
      if (state.painted.has(k)) return;
      const t = svgText(originX + g[0] * 48 + 24, originY + g[1] * 48 + 24, String(i + 1));
      gNums.appendChild(t);
      state.numNodes.set(k, t);
    });
    svgRoot.appendChild(gNums);

    // 棋子
    const piece = svg('g', { id: 'piece' });
    piece.appendChild(svg('circle', { cx: 0, cy: 0, r: 19, fill: 'url(#softGlow)' }));
    piece.appendChild(svg('circle', { cx: 0, cy: 0, r: 13.5, fill: ink.main, stroke: '#f8f4ea', 'stroke-width': '2.5' }));
    piece.appendChild(svg('circle', { cx: -4, cy: -4.5, r: 3.4, fill: '#ffffff', opacity: '.4' }));
    svgRoot.appendChild(piece);
    state.piece = piece;

    state.pos = { x: L.player[0], y: L.player[1] };
    layoutStroke();
    placePiece();
    applyTileStates();

    ui.badge.hidden = state.levelIndex >= 0;
  }

  function toPx(x, y) {
    const L = state.level;
    const n = Math.max(L.w, L.h);
    const span = n * 48 + 30;
    const originX = span - (L.w * 48 + 15);
    const originY = span - (L.h * 48 + 15);
    return [originX + x * 48 + 24, originY + y * 48 + 24];
  }

  function layoutStroke() {
    const L = state.level;
    const pts = [];
    let cx = L.player[0], cy = L.player[1];
    const [sx, sy] = toPx(cx, cy);
    pts.push(sx.toFixed(1) + ',' + sy.toFixed(1));
    for (const dir of state.undoStack) {
      const sim = simulate(L, cx, cy, dir);
      cx = sim.end[0]; cy = sim.end[1];
      const [ex, ey] = toPx(cx, cy);
      pts.push(ex.toFixed(1) + ',' + ey.toFixed(1));
    }
    const line = state.strokeLine;
    if (!line) return;
    line.setAttribute('points', pts.join(' '));
  }

  function placePiece() {
    const [px, py] = toPx(state.pos.x, state.pos.y);
    if (state.piece) state.piece.setAttribute('transform', 'translate(' + px + ',' + py + ')');
  }

  function applyTileStates() {
    state.cellNodes.forEach((tile, k) => {
      const on = state.painted.has(k);
      tile.setAttribute('opacity', on ? '0.58' : '0');
      tile.classList.toggle('painted', on);
    });
    syncGoalNumbers();
  }

  /** 目标编号只显示在「还没涂到」的目标格上（悔棋 / 重来 / 起点即目标都要对） */
  function syncGoalNumbers() {
    if (!state.numberLayer || !state.numNodes) return;
    const L = state.level;
    const ox = state.origin ? state.origin[0] : 0;
    const oy = state.origin ? state.origin[1] : 0;
    L.goals.forEach((g, i) => {
      const k = key(g[0], g[1]);
      const shouldShow = !state.painted.has(k);
      const node = state.numNodes.get(k);
      if (shouldShow && !node) {
        const t = svgText(ox + g[0] * 48 + 24, oy + g[1] * 48 + 24, String(i + 1));
        state.numberLayer.appendChild(t);
        state.numNodes.set(k, t);
      } else if (!shouldShow && node) {
        clearGoalNumber(k);
      }
    });
  }

  /** 棋子滑行动画：撞墙回弹 + 到达时的挤压
   *  注意：标签页在后台时浏览器会暂停 requestAnimationFrame，
   *  所以这里额外挂了一个兜底定时器，保证动画一定会收尾、输入不会被永久锁住。
   *  （window.__DSH_TEST_SETTLE_MS 只给自动化测试用，设成很小的值即可立即收尾。） */
  function animateSlide(from, to, done) {
    const start = performance.now();
    const dur = 175;
    const [x0, y0] = [from.x, from.y];
    const [x1, y1] = [to.x, to.y];

    const finish = () => {
      if (!state.animating) return;
      if (state.settleTimer) { clearTimeout(state.settleTimer); state.settleTimer = null; }
      state.pos = { x: x1, y: y1 };
      placePiece();
      state.raf = null;
      state.animating = false;
      if (done) done();
    };

    const run = (now) => {
      if (!state.animating) return;            // 已经被兜底定时器收尾了
      const t = Math.min(1, (now - start) / dur);
      const eased = 1 - Math.pow(1 - t, 3);
      state.pos = { x: x0 + (x1 - x0) * eased, y: y0 + (y1 - y0) * eased };
      const squash = 1 + 0.16 * Math.sin(Math.PI * t);
      state.piece.setAttribute('transform',
        'translate(' + toPx(state.pos.x, state.pos.y).join(',') + ') scale(' + squash + ',' + (2 - squash) + ')');
      if (t < 1) { state.raf = requestAnimationFrame(run); }
      else finish();
    };

    state.animating = true;
    const settleMs = (typeof window !== 'undefined' && window.__DSH_TEST_SETTLE_MS) || dur + 220;
    state.settleTimer = setTimeout(finish, settleMs);
    state.raf = requestAnimationFrame(run);
  }

  function spawnRipple(cx, cy, index, ink) {
    const g = state.rippleLayer;
    if (!g) return;
    const c = svg('circle', {
      cx: cx, cy: cy, r: 2, stroke: ink, 'class': 'ripple', opacity: '0'
    });
    g.appendChild(c);
    const id = setTimeout(() => {
      c.classList.add('on');
      const id2 = setTimeout(() => { if (c.parentNode) c.parentNode.removeChild(c); }, 700);
      state.rippleTimers.push(id2);
    }, index * 32);
    state.rippleTimers.push(id);
  }

  /* ---- 上色 ----
     painted 是逻辑状态（决定是否过关），tile 的颜色是视觉表现，
     两者必须分开推进：逻辑要先知道「这一步新涂了哪些格」，
     再做视觉上色，否则 tile 会因为已经算作 painted 而永远不被染色。 */

  /** 给这批格子加涟漪（纯视觉，即使已经上过色也可以再来一圈） */
  function rippleCells(cells, ink) {
    cells.forEach(([cx, cy], i) => {
      const [px, py] = toPx(cx, cy);
      spawnRipple(px, py, i, ink);
    });
  }

  /** 把格子染上墨色（带一点错落感），并抹掉该格的目标编号。
   *  注意：这里只做视觉，逻辑上的 painted 由 move() 负责。 */
  function paintCells(cells) {
    cells.forEach(([cx, cy], i) => {
      const k = key(cx, cy);
      const tile = state.cellNodes.get(k);
      const delay = Math.min(i * 28, 240);
      const id = setTimeout(() => {
        if (tile) {
          tile.setAttribute('opacity', '0.58');
          tile.classList.add('painted');
        }
        clearGoalNumber(k);
      }, delay);
      state.rippleTimers.push(id);
    });
  }

  /* ---- 提示：闪烁下一步骤 ---- */
  function showHint() {
    const L = state.level;
    const sol = state.levelIndex >= 0
      ? L.solution
      : (state.endlessSolution || (genSolutionFor(L)));

    if (!sol || !sol.length) {
      toast('这关靠你自己了 —— 先重来试试');
      return;
    }

    // 从当前进度找回同一条解法：若已走偏，就自己搜一条最短解
    let path = sol;
    if (state.moves > 0 || state.painted.size > 0) {
      const solved = solve(makeProgressLevel(), 16);
      path = solved ? solved.path : sol;
    }
    if (!path || !path.length) { toast('已经到终点了？'); return; }

    const dir = path[0];
    toast('提示：往「' + ({ up: '上', down: '下', left: '左', right: '右' }[dir]) + '」滑');
    const cells = simulate(L, state.pos.x | 0, state.pos.y | 0, dir).cells;

    state.showSolution = true;
    cells.forEach(([cx, cy], i) => {
      const [px, py] = toPx(cx, cy);
      const ring = svg('circle', {
        cx: px, cy: py, r: 20, fill: 'none', stroke: inkFor(state.levelIndex).ripple,
        'stroke-width': '3', opacity: '0'
      });
      state.rippleLayer.appendChild(ring);
      const id = setTimeout(() => { ring.setAttribute('opacity', '0.85'); }, i * 40);
      const id2 = setTimeout(() => { ring.setAttribute('opacity', '0'); }, i * 40 + 620);
      const id3 = setTimeout(() => { if (ring.parentNode) ring.parentNode.removeChild(ring); state.showSolution = false; }, i * 40 + 780);
      state.rippleTimers.push(id, id2, id3);
    });
  }

  /** 把「剩下的目标」做成一个临时关卡，便于从当前局面重新求解 */
  function makeProgressLevel() {
    const L = state.level;
    const goals = L.goals.filter((g) => !state.painted.has(key(g[0], g[1])));
    return {
      w: L.w, h: L.h, walls: new Set(L.walls),
      player: [Math.round(state.pos.x), Math.round(state.pos.y)],
      goals: goals.length ? goals : L.goals.slice(),
      min: undefined
    };
  }

  function genSolutionFor(L) {
    const solved = solve({ w: L.w, h: L.h, walls: new Set(L.walls), player: L.player.slice(), goals: L.goals.map((g) => g.slice()) }, 16);
    return solved ? solved.path : null;
  }

  /* ==========================================================
     七、玩法流程
     ========================================================== */

  function startLevel(index, seed) {
    if (index >= 0 && index < LEVELS.length) {
      state.levelIndex = index;
      state.endlessSeed = 0;
      state.level = normalizeLevel(LEVELS[index]);
      state.level.name = LEVELS[index].name;
    } else {
      // 无尽即兴局
      state.levelIndex = -1;
      const s = seed === undefined || seed === null ? (Date.now() % 1e9) : seed;
      state.endlessSeed = s;
      let gen = null;
      for (let i = 0; i < 12 && !gen; i++) gen = genLevel(s + i, 8);
      if (!gen) { toast('生成失败，换一关'); return startLevel(0); }
      state.level = normalizeLevel(gen);
      state.endlessSolution = gen.solution ? gen.solution.slice() : null;
    }

    if (state.level.min === undefined) {
      const s = solve(state.level, 16);
      if (s) { state.level.min = s.moves; state.level.solution = s.path; }
    }

    state.moves = 0;
    state.painted = new Set();
    state.undoStack = [];
    state.locked = false;
    state.solved = false;
    if (state.raf) { cancelAnimationFrame(state.raf); state.raf = null; }
    if (state.settleTimer) { clearTimeout(state.settleTimer); state.settleTimer = null; }

    renderLevel();
    // 起点若正好在目标格上，直接算涂过
    const pk = key(state.level.player[0], state.level.player[1]);
    if (state.level.goals.some((g) => key(g[0], g[1]) === pk)) {
      state.painted.add(pk);
      applyTileStates();
    }
    ui.stage.classList.remove('solved');
    refreshHud();
    setTip('default');
    hideAllOverlays();
    persist();
  }

  function move(dir) {
    if (state.locked || state.animating) return;
    const L = state.level;
    const x = Math.round(state.pos.x), y = Math.round(state.pos.y);
    const sim = simulate(L, x, y, dir);

    if (!sim.moved) {
      // 撞墙：抖一下，不算步数（同样带兜底定时器，避免后台标签页把输入锁死）
      state.locked = true;
      if (state.piece) {
        const [px, py] = toPx(x, y);
        const ox = DIRS[dir][0] * 5, oy = DIRS[dir][1] * 5;
        let t = 0;
        const settleBump = () => {
          if (state.settleTimer) { clearTimeout(state.settleTimer); state.settleTimer = null; }
          state.piece.setAttribute('transform', 'translate(' + px + ',' + py + ')');
          state.locked = false;
        };
        const shimmy = () => {
          t++;
          const k = Math.sin(t * 1.5) * (1 - t / 8);
          state.piece.setAttribute('transform', 'translate(' + (px + ox * k) + ',' + (py + oy * k) + ')');
          if (t < 8) requestAnimationFrame(shimmy);
          else settleBump();
        };
        requestAnimationFrame(shimmy);
        const bumpMs = (typeof window !== 'undefined' && window.__DSH_TEST_SETTLE_MS) || 200;
        state.settleTimer = setTimeout(settleBump, bumpMs);
      } else {
        state.locked = false;
      }
      Audio_.bump();
      setTip('bump');
      return;
    }

    const ink = inkFor(state.levelIndex >= 0 ? state.levelIndex : state.endlessSeed);
    // 先算出这一步新涂了哪些格（必须在更新 painted 之前算）
    const seenThisMove = new Set();
    const newlyPainted = sim.cells.filter(([cx, cy]) => {
      const k = key(cx, cy);
      if (seenThisMove.has(k)) return false;   // 同一步里不重复处理
      seenThisMove.add(k);
      return !state.painted.has(k);
    });
    const newKeys = newlyPainted.map(([cx, cy]) => key(cx, cy));

    state.undoStack.push(dir);
    state.moves++;
    newKeys.forEach((k) => state.painted.add(k));
    state.locked = true;

    layoutStroke();
    paintCells(newlyPainted);              // 视觉上色
    rippleCells(newlyPainted, ink.ripple); // 涟漪
    Audio_.slide();
    if (newKeys.length) Audio_.paint(newKeys.length);
    refreshHud();

    const from = { x: state.pos.x, y: state.pos.y };
    const to = { x: sim.end[0], y: sim.end[1] };
    animateSlide(from, to, () => {
      state.locked = false;
      checkWin();
    });
  }

  function checkWin() {
    const total = state.level.goals.length;
    const got = state.level.goals.filter((g) => state.painted.has(key(g[0], g[1]))).length;
    if (got < total || state.solved) { refreshHud(); return; }

    state.solved = true;
    ui.stage.classList.add('solved');
    Audio_.win();

    const min = state.level.min || state.moves;
    const stars = starsFor(state.moves, min);
    const record = state.levelIndex >= 0 ? bestFor(state.levelIndex) : null;

    let improved = false;
    if (state.levelIndex >= 0) {
      if (!record || state.moves < record.moves) {
        state.save[state.levelIndex] = { moves: state.moves, stars: stars };
        persist();
        improved = true;
      }
    }

    showWin(stars, improved);
    refreshHud();
  }

  function bestFor(i) {
    const r = state.save[i];
    return r && typeof r.moves === 'number' ? r : null;
  }

  function undo() {
    if (state.locked || state.animating || !state.undoStack.length) return;
    state.undoStack.pop();
    state.moves = Math.max(0, state.moves - 1);
    state.solved = false;
    ui.stage.classList.remove('solved');

    // 重放剩余步骤，得到正确的已涂集合与位置
    const L = state.level;
    let x = L.player[0], y = L.player[1];
    const painted = new Set();
    const startKey = key(x, y);
    if (L.goals.some((g) => key(g[0], g[1]) === startKey)) painted.add(startKey);
    for (const d of state.undoStack) {
      const sim = simulate(L, x, y, d);
      sim.cells.forEach(([cx, cy]) => painted.add(key(cx, cy)));
      x = sim.end[0]; y = sim.end[1];
    }
    state.painted = painted;
    state.pos = { x: x, y: y };
    layoutStroke();
    placePiece();
    applyTileStates();
    refreshHud();
    setTip('undo');
  }

  function refreshHud() {
    const L = state.level;
    ui.statLevel.textContent = state.levelIndex >= 0 ? String(state.levelIndex + 1) : '∞';
    ui.statMoves.textContent = String(state.moves);
    ui.statTotal.textContent = String(L.goals.length);
    const got = L.goals.filter((g) => state.painted.has(key(g[0], g[1]))).length;
    ui.statPainted.textContent = String(got);

    if (state.levelIndex >= 0) {
      const b = bestFor(state.levelIndex);
      ui.statStars.textContent = b ? starString(b.stars) : '—';
    } else {
      ui.statStars.textContent = '—';
    }

    ui.btnUndo.disabled = state.undoStack.length === 0 || state.locked;
    ui.btnNext.disabled = state.levelIndex < 0;
  }

  function setTip(mode) {
    const L = state.level;
    const min = L.min;
    const minText = min ? '最少 ' + min + ' 步' : '步数未知';
    const map = {
      default: '目标：把 ' + L.goals.length + ' 个编号格涂满（' + minText + '）。',
      bump: '撞墙了，换个方向。',
      undo: '已退回一步。',
      solved: '完成了！可以试试更少的步数。'
    };
    ui.tip.textContent = map[mode] || map.default;
    ui.tip.classList.toggle('ready', mode === 'solved');
  }

  function showWin(stars, improved) {
    const min = state.level.min;
    ui.winSub.textContent = '用了 ' + state.moves + ' 步' + (min ? '（最少 ' + min + ' 步）' : '');
    ui.winStars.innerHTML = [0, 1, 2].map((i) =>
      '<span class="' + (i < stars ? 'lit' : '') + '">★</span>').join('');

    const b = state.levelIndex >= 0 ? bestFor(state.levelIndex) : null;
    const lines = [];
    if (improved) lines.push('新纪录！');
    if (b) lines.push('本关最佳：' + b.moves + ' 步 ' + starString(b.stars));
    if (state.levelIndex === LEVELS.length - 1) lines.push('固定关卡全部完成，进入无尽即兴局吧');
    ui.winBest.textContent = lines.join(' · ');

    ui.btnNext.textContent = state.levelIndex >= 0 && state.levelIndex < LEVELS.length - 1
      ? '下一关 →' : '无尽即兴局 →';
    show(ui.win);
  }

  function nextLevel() {
    if (state.levelIndex < 0 || state.levelIndex >= LEVELS.length - 1) {
      startLevel(-1);
    } else {
      startLevel(state.levelIndex + 1);
    }
  }

  function replaySolution() {
    const L = state.level;
    const dirs = state.levelIndex >= 0 ? L.solution : state.endlessSolution;
    if (!dirs || !dirs.length) { toast('没有可播放的解'); return; }
    hide(ui.win);
    startLevel(state.levelIndex, state.levelIndex < 0 ? state.endlessSeed : undefined);
    let i = 0;
    const tick = () => {
      if (i >= dirs.length) return;
      move(dirs[i++]);
      setTimeout(tick, 330);
    };
    setTimeout(tick, 220);
    toast('自动作答中…');
  }

  /* ==========================================================
     八、弹层与提示
     ========================================================== */

  function show(node) { node.hidden = false; }
  function hide(node) { node.hidden = true; }

  /** 保证所有弹层关闭（切关时也要清干净，否则弹层会一直挡住键盘输入） */
  function hideAllOverlays() {
    hide(ui.win);
    hide(ui.picker);
    hide(ui.help);
    hide(ui.toast);
    clearTimeout(toastTimer);
  }

  let toastTimer = null;
  function toast(msg) {
    ui.toast.textContent = msg;
    ui.toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { ui.toast.hidden = true; }, 1900);
  }

  function buildPicker() {
    const grid = ui.levelGrid;
    grid.innerHTML = '';
    LEVELS.forEach((raw, i) => {
      const b = document.createElement('button');
      b.type = 'button';
      const rec = bestFor(i);
      b.innerHTML = '<span class="n">' + (i + 1) + '</span>' +
        '<span class="s' + (rec ? '' : ' empty') + '">' + (rec ? starString(rec.stars) : '未通关') + '</span>';
      if (i === state.levelIndex) b.classList.add('current');
      b.addEventListener('click', () => { hide(ui.picker); startLevel(i); });
      grid.appendChild(b);
    });
  }

  /* ==========================================================
     九、输入
     ========================================================== */

  const KEYMAP = {
    ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right',
    w: 'up', s: 'down', a: 'left', d: 'right',
    W: 'up', S: 'down', A: 'left', D: 'right'
  };

  function bindInput() {
    window.addEventListener('keydown', (e) => {
      // 任何键都能唤醒音频上下文
      Audio_.ensure();

      if (e.key === 'Escape') {
        if (!ui.win.hidden) { hide(ui.win); return; }
        if (!ui.picker.hidden) { hide(ui.picker); return; }
        if (!ui.help.hidden) { hide(ui.help); return; }
      }

      if (!ui.win.hidden || !ui.picker.hidden) {
        if (e.key === 'Enter') {
          if (!ui.win.hidden) { hide(ui.win); nextLevel(); }
          else hide(ui.picker);
          e.preventDefault();
        }
        return;
      }
      if (!ui.help.hidden) {
        if (e.key === 'Enter' || e.key === ' ') { hide(ui.help); e.preventDefault(); }
        return;
      }

      const dir = KEYMAP[e.key];
      if (dir) { e.preventDefault(); move(dir); return; }

      if (e.key === 'z' || e.key === 'Z') { e.preventDefault(); undo(); }
      else if (e.key === 'r' || e.key === 'R') { e.preventDefault(); startLevel(state.levelIndex, state.levelIndex < 0 ? state.endlessSeed : undefined); }
      else if (e.key === 'h' || e.key === 'H') { e.preventDefault(); showHint(); }
      else if (e.key === 'n' || e.key === 'N') { e.preventDefault(); nextLevel(); }
    });

    // 触屏 / 鼠标滑动
    let active = false, sx = 0, sy = 0, fired = false;
    const stage = ui.stage;

    stage.addEventListener('pointerdown', (e) => {
      Audio_.ensure();
      active = true; fired = false;
      sx = e.clientX; sy = e.clientY;
      if (stage.setPointerCapture) { try { stage.setPointerCapture(e.pointerId); } catch (err) { /* 忽略 */ } }
    });

    stage.addEventListener('pointermove', (e) => {
      if (!active || fired) return;
      const dx = e.clientX - sx, dy = e.clientY - sy;
      const TH = 26;
      if (Math.abs(dx) < TH && Math.abs(dy) < TH) return;
      fired = true;
      move(Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : (dy > 0 ? 'down' : 'up'));
    });

    const end = () => { active = false; };
    stage.addEventListener('pointerup', end);
    stage.addEventListener('pointercancel', end);
    stage.addEventListener('pointerleave', end);
    stage.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  function bindUI() {
    ui.btnUndo.addEventListener('click', undo);
    ui.btnRestart.addEventListener('click', () => startLevel(state.levelIndex, state.levelIndex < 0 ? state.endlessSeed : undefined));
    ui.btnHint.addEventListener('click', () => { Audio_.ensure(); showHint(); });
    ui.btnNext.addEventListener('click', nextLevel);

    ui.btnLevels.addEventListener('click', () => { buildPicker(); show(ui.picker); });
    ui.btnPickerClose.addEventListener('click', () => hide(ui.picker));
    ui.btnEndless.addEventListener('click', () => { hide(ui.picker); startLevel(-1); });

    ui.btnHelp.addEventListener('click', () => show(ui.help));
    ui.btnHelpClose.addEventListener('click', () => hide(ui.help));

    ui.btnSound.addEventListener('click', () => {
      Audio_.enabled = !Audio_.enabled;
      ui.btnSound.textContent = Audio_.enabled ? '音效 · 开' : '音效 · 关';
      ui.btnSound.setAttribute('aria-pressed', String(Audio_.enabled));
      if (Audio_.enabled) { Audio_.ensure(); Audio_.tone(660, 0.1, 'sine', 0.05); }
    });

    ui.btnReplay.addEventListener('click', replaySolution);
    ui.btnAgain.addEventListener('click', () => { hide(ui.win); startLevel(state.levelIndex, state.levelIndex < 0 ? state.endlessSeed : undefined); });
    ui.btnWinNext.addEventListener('click', () => { hide(ui.win); nextLevel(); });

    // 点击遮罩空白处关闭
    [ui.picker, ui.help].forEach((ov) => {
      ov.addEventListener('click', (e) => { if (e.target === ov) hide(ov); });
    });
  }

  /* ==========================================================
     十、启动
     ========================================================== */

  function cache() {
    ui = {
      svg: el('board'),
      stage: el('stage'),
      badge: el('badge'),
      tip: el('tip'),
      statLevel: el('stat-level'),
      statMoves: el('stat-moves'),
      statPainted: el('stat-painted'),
      statTotal: el('stat-total'),
      statStars: el('stat-stars'),
      btnUndo: el('btn-undo'),
      btnRestart: el('btn-restart'),
      btnHint: el('btn-hint'),
      btnNext: el('btn-next'),
      btnLevels: el('btn-levels'),
      btnHelp: el('btn-help'),
      btnSound: el('btn-sound'),
      picker: el('picker'),
      levelGrid: el('level-grid'),
      btnPickerClose: el('btn-picker-close'),
      btnEndless: el('btn-endless'),
      help: el('help'),
      btnHelpClose: el('btn-help-close'),
      win: el('win'),
      winSub: el('win-sub'),
      winStars: el('win-stars'),
      winBest: el('win-best'),
      btnReplay: el('btn-replay'),
      btnAgain: el('btn-again'),
      btnWinNext: el('btn-win-next'),
      toast: el('toast')
    };
  }

  /* ---- URL 参数：?level=5 直接进某关，?endless=1 进即兴局，?nointro=1 不弹玩法说明 ----
     方便把某一关直接分享给别人，也方便截图 / 自动化。 */
  function readQuery() {
    const q = { level: 1, endless: false, intro: true };
    if (typeof location === 'undefined' || !location.search) return q;
    const params = new URLSearchParams(location.search);
    if (params.has('level')) {
      const n = parseInt(params.get('level'), 10);
      if (n >= 1 && n <= LEVELS.length) q.level = n;
      if (String(params.get('level')).toLowerCase() === 'inf') q.endless = true;
    }
    if (params.has('endless')) q.endless = true;
    if (params.has('nointro')) q.intro = false;
    return q;
  }

  function boot() {
    if (LINT.length) console.warn('[墨迹成行] 关卡数据有问题：', LINT);
    cache();
    bindUI();
    bindInput();

    const query = readQuery();

    // 先确保所有弹层都是关的（不依赖 HTML 的默认状态），再开第一关
    let seen = true;
    try { seen = !!localStorage.getItem(STORE_KEY + '.seen'); } catch (e) { seen = false; }
    hideAllOverlays();

    if (query.endless) startLevel(-1);
    else startLevel(query.level - 1);

    // 首次访问时展示玩法
    if (!seen && query.intro) {
      show(ui.help);
      try { localStorage.setItem(STORE_KEY + '.seen', '1'); } catch (e) { /* 忽略 */ }
    }
  }

  const IN_BROWSER = typeof document !== 'undefined' && typeof window !== 'undefined';

  if (IN_BROWSER) {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
    else boot();
  }

  // 供 Node 测试脚本使用（tests/verify.js）
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      LEVELS, DIRS, key, simulate, solve, replayPath, starsFor, genLevel,
      normalizeLevel, lintLevels, mulberry32, COLS_HARDCODED
    };
  }
})();
