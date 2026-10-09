/* ============================================================
   墨迹成行 · 关卡调参小工具（开发用，游戏本身不需要它）
   用法： node tools/tune-levels.js [每关候选数]

   做两件事：
   1. 对每张手写的墙体布局，算出「真正可达」的格子集合，
      再随机挑目标组合并求解，输出步数适中（3~8 步）、数量合适（4~7 个）
      的候选，方便直接抄进 game.js。
   2. 打印每张布局的可达格数量，用来判断布局本身好不好。
   ============================================================ */
'use strict';

const path = require('path');
const G = require(path.join(__dirname, '..', 'game.js'));
const { LEVELS, DIRS, key, simulate, solve, normalizeLevel } = G;

const WANT = parseInt(process.argv[2], 10) || 6;
const MIN_MOVES = parseInt(process.argv[3], 10) || 4;
const MAX_MOVES = parseInt(process.argv[4], 10) || 8;
const MEASURE = process.argv.indexOf('--measure') >= 0;

// 难度递进：前几关要短，后面几关要长（宽松一些，先看看各布局实际能做到多少步）
const RANGE = [
  [3, 5], [3, 5], [4, 7], [4, 6], [5, 8], [5, 8],
  [5, 8], [6, 9], [5, 8], [6, 9], [6, 9], [7, 10]
];

/** 起点出发、允许穿墙滑行时能经过的所有格子 */
function reachable(level) {
  const pass = new Set();
  const seen = new Set();
  const q = [[level.player[0], level.player[1]]];
  seen.add(key(level.player[0], level.player[1]));
  pass.add(key(level.player[0], level.player[1]));
  while (q.length) {
    const [x, y] = q.shift();
    for (const dir of Object.keys(DIRS)) {
      const sim = simulate(level, x, y, dir);
      if (!sim.moved) continue;
      for (const c of sim.cells) pass.add(key(c[0], c[1]));
      const k = key(sim.end[0], sim.end[1]);
      if (!seen.has(k)) { seen.add(k); q.push(sim.end); }
    }
  }
  return pass;
}

function rng(seed) {
  let a = seed;
  return function () {
    a = (a * 1103515245 + 12345) & 0x7fffffff;
    return a / 0x7fffffff;
  };
}

function combos(arr, k, R, tries) {
  const out = [];
  for (let t = 0; t < tries; t++) {
    const pool = arr.slice();
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(R() * (i + 1));
      const tmp = pool[i]; pool[i] = pool[j]; pool[j] = tmp;
    }
    out.push(pool.slice(0, k));
  }
  return out;
}

console.log('\n每张布局的可达性与推荐目标组合' + (MEASURE ? '（测量模式：找每张布局能做到的最深步数）' : ''));
console.log('='.repeat(78));

const report = [];
const measured = [];

LEVELS.forEach((raw, i) => {
  const base = normalizeLevel(raw);
  const reach = reachable(base);
  const cells = [];
  reach.forEach((k) => {
    const [x, y] = k.split(',').map(Number);
    if (!base.walls.has(k)) cells.push([x, y]); // 目标放浅色格上更直观
  });

  const R = rng(1000 + i * 977);

  if (MEASURE) {
    // 直接枚举各种目标数量下的大量随机组合，记录出现的最大最优步数
    let best = null;
    for (let goalCount = 3; goalCount <= 9; goalCount++) {
      if (goalCount > cells.length) break;
      for (const goals of combos(cells, goalCount, R, 700)) {
        const L = {
          w: base.w, h: base.h, walls: new Set(base.walls),
          player: base.player.slice(), goals: goals.map((g) => g.slice())
        };
        const sol = solve(L, 14);
        if (!sol) continue;
        if (!best || sol.moves > best.moves) best = { moves: sol.moves, goals, path: sol.path };
      }
    }
    measured.push({ '#': i + 1, 名称: raw.name, 尺寸: base.w + '×' + base.h, 可达格: cells.length,
      最深步数: best ? best.moves : 0, 目标: best ? JSON.stringify(best.goals) : '—' });
    return;
  }

  const cands = [];
  const [lo, hi] = RANGE[i] || [MIN_MOVES, MAX_MOVES];
  for (let goalCount = 4; goalCount <= 9; goalCount++) {
    if (goalCount > cells.length) break;
    const tries = combos(cells, goalCount, R, 400);
    for (const goals of tries) {
      const L = {
        w: base.w, h: base.h, walls: new Set(base.walls),
        player: base.player.slice(), goals: goals.map((g) => g.slice())
      };
      const sol = solve(L, 14);
      if (!sol) continue;
      const m = sol.moves;
      if (m < lo || m > hi) continue;
      const ratio = goals.length / m;
      if (ratio < 0.6 || ratio > 1.5) continue;
      // 评分：步数多一点 + 目标多一点更耐玩
      const score = m * 10 + goals.length * 4;
      cands.push({ goals, moves: m, score, path: sol.path });
    }
  }
  cands.sort((a, b) => b.score - a.score);
  const uniq = [];
  const seenSets = new Set();
  for (const c of cands) {
    const sig = c.goals.map((g) => key(g[0], g[1])).sort().join('|');
    if (seenSets.has(sig)) continue;
    seenSets.add(sig);
    uniq.push(c);
    if (uniq.length >= WANT) break;
  }

  console.log('\n第 ' + (i + 1) + ' 关 <' + raw.name + '>  ' + base.w + '×' + base.h +
    '  墙 ' + base.walls.size + ' 个  可达可涂格 ' + cells.length + '/' + (base.w * base.h - base.walls.size));

  if (!uniq.length) {
    console.log('  ！找不到合适的目标组合（可能布局太死板，建议换墙）');
    report.push({ '#': i + 1, 名称: raw.name, 目标: '—', 步数: '—' });
    return;
  }

  uniq.forEach((c, n) => {
    const dirs = c.path.map((d) => ({ up: '↑', down: '↓', left: '←', right: '→' }[d])).join('');
    console.log('  [' + n + '] ' + c.moves + ' 步  目标 ' + JSON.stringify(c.goals) + '   ' + dirs);
    if (n === 0) report.push({ '#': i + 1, 名称: raw.name, 目标: JSON.stringify(c.goals), 步数: c.moves });
  });
});

console.log('\n' + '='.repeat(78));
if (MEASURE) {
  console.log('各布局能做到的最深步数（越高越耐玩）：');
  console.log('='.repeat(78));
  console.table(measured);
  console.log('');
} else {
  console.log('各关首选（可直接替换 game.js 里的 goals）：');
  console.log('='.repeat(78));
  report.forEach((r) => {
    console.log('  ' + String(r['#']).padStart(2) + '  ' + r.名称.padEnd(10) + ' ' + r.步数 + ' 步  ' + r.目标);
  });
  console.log('');
}
