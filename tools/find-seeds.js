/* ============================================================
   墨迹成行 · 关卡种子搜索（开发用）
   用法： node tools/find-seeds.js

   有些关卡用「手写墙」做不出足够深的解法（例如 7×7 的对折布局
   最多只能做到 4 步）。这个脚本用生成器（走一条随机滑行路径、
   路径没碰过的格子全变墙）去搜种子，挑出最优步数落在目标区间、
   目标格又足够多的棋盘，把种子抄进 game.js 的 DERIVED 即可。
   ============================================================ */
'use strict';

const path = require('path');
const G = require(path.join(__dirname, '..', 'game.js'));
const { genLevel, solve, simulate, normalizeLevel, DIRS } = G;

// 需要生成器产出的关卡：[关卡号, 名称, 棋盘尺寸, 走几步, 目标步数下限, 目标步数上限, 目标个数下限]
const TARGETS = [
  [4, '回廊', 6, 10, 5, 7, 5],
  [7, '阶梯', 7, 12, 6, 8, 5],
  [9, '对折', 7, 12, 6, 8, 5],
  [10, '一线天', 8, 14, 7, 9, 6],
  [11, '碎格', 8, 14, 7, 9, 6]
];

/** 随机生成的棋盘是否「好看」：不能有一整行/整列都是墙，起手要有至少两种走法 */
function looksGood(L) {
  for (let y = 0; y < L.h; y++) {
    let full = true;
    for (let x = 0; x < L.w; x++) if (!L.walls.has(x + ',' + y)) { full = false; break; }
    if (full) return false;
  }
  for (let x = 0; x < L.w; x++) {
    let full = true;
    for (let y = 0; y < L.h; y++) if (!L.walls.has(x + ',' + y)) { full = false; break; }
    if (full) return false;
  }
  let options = 0;
  for (const d of Object.keys(DIRS)) if (simulate(L, L.player[0], L.player[1], d).moved) options++;
  return options >= 2;
}

console.log('\n搜索生成器种子');
console.log('='.repeat(74));

const SUGGEST = [];

TARGETS.forEach(([no, name, size, walk, lo, hi, minGoals]) => {
  let found = [];
  const t0 = Date.now();
  for (let seed = 1; seed <= 40000 && found.length < 3; seed++) {
    const L = genLevel(seed, size, walk);
    if (!L) continue;
    if (L.goals.length < minGoals) continue;
    if (L.min < lo || L.min > hi) continue;
    if (!looksGood(L)) continue;
    const norm = normalizeLevel(L);
    const sol = solve(norm, 20);           // 复核一次
    if (!sol || sol.moves !== L.min) continue;
    found.push({ seed, moves: L.min, goals: L.goals.length, walls: L.walls.size, player: L.player });
  }
  const ms = Date.now() - t0;
  console.log('\n第 ' + no + ' 关 <' + name + '>  ' + size + '×' + size + '  走 ' + walk +
    ' 步  期望最优 ' + lo + '~' + hi + ' 步，目标 ≥' + minGoals + ' 个   （' + ms + 'ms）');
  if (!found.length) {
    console.log('  ！没搜到，放宽区间或换尺寸');
    return;
  }
  found.forEach((f) => {
    console.log('  seed ' + String(f.seed).padStart(5) +
      '  最优 ' + f.moves + ' 步  目标 ' + f.goals + ' 个  墙 ' + f.walls + '  起点 ' + JSON.stringify(f.player));
  });
  const best = found.slice().sort((a, b) => (b.moves - a.moves) || (b.goals - a.goals))[0];
  SUGGEST.push({ 关卡: no, 名称: name, 尺寸: size, 走几步: walk, seed: best.seed, 最优步数: best.moves, 目标数: best.goals });
});

console.log('\n' + '='.repeat(74));
console.log('建议写进 game.js 的 DERIVED（关卡号 -> { seed, size, walk }）：');
console.log('='.repeat(74));
SUGGEST.forEach((s) => {
  console.log('  ' + String(s.关卡).padStart(2) + '  ' + s.名称.padEnd(8) +
    '  { seed: ' + s.seed + ', size: ' + s.尺寸 + ', walk: ' + s.走几步 + ' },   // 最优 ' + s.最优步数 + ' 步 / ' + s.目标数 + ' 目标');
});
console.log('');
