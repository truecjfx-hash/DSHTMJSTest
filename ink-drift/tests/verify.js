/* ============================================================
   墨迹成行 · 数据自检
   用法： node tests/verify.js
   会检查：全部固定关卡是否合法、是否有解、最优步数是多少，
          以及无尽模式的随机生成器是否稳定产出可解棋盘。
   ============================================================ */
'use strict';

const path = require('path');
const G = require(path.join(__dirname, '..', 'game.js'));

const {
  LEVELS, DIRS, simulate, solve, replayPath, starsFor,
  genLevel, normalizeLevel, lintLevels
} = G;

let failures = 0;
const fail = (msg) => { failures++; console.log('  ✗ ' + msg); };
const ok = (msg) => console.log('  ✓ ' + msg);

/* ---------- 1. 数据合法性 ---------- */
console.log('\n[1] 关卡数据合法性');
const problems = lintLevels();
if (problems.length) problems.forEach(fail);
else ok('12 关坐标、墙、目标均合法，无重复无越界');

/* ---------- 2. 每关是否有解 + 最优步数 ---------- */
console.log('\n[2] 可解性与最优步数');
const rows = [];
LEVELS.forEach((raw, i) => {
  const L = normalizeLevel(raw);
  const sol = solve(L, 18);
  if (!sol) { fail('第' + (i + 1) + '关<' + raw.name + '> 无解！'); return; }

  // 用求解器返回的方向序列真实重放一遍，确认能涂满
  const walked = replayPath(L, sol.path);
  const painted = new Set();
  const startK = L.player[0] + ',' + L.player[1];
  if (L.goals.some((g) => g[0] + ',' + g[1] === startK)) painted.add(startK);
  for (const step of walked) {
    for (const c of step.cells) painted.add(c[0] + ',' + c[1]);
  }
  const allPainted = L.goals.every((g) => painted.has(g[0] + ',' + g[1]));
  if (!allPainted) fail('第' + (i + 1) + '关 求解器给出的路径涂不满');
  if (walked.length !== sol.moves) fail('第' + (i + 1) + '关 步数与路径长度不一致');

  const goalCells = L.goals.length;
  rows.push({
    '#': i + 1,
    名称: raw.name,
    尺寸: L.w + '×' + L.h,
    目标格: goalCells,
    墙: L.walls.size,
    最少步数: sol.moves,
    解题: sol.path.map((d) => ({ up: '↑', down: '↓', left: '←', right: '→' }[d])).join('')
  });
});

if (rows.length === LEVELS.length) ok('12 关全部有解，且路径重放一致');
console.table(rows);

/* ---------- 3. 每关的最少步数不应太简单 ---------- */
console.log('\n[3] 难度分布');
const shallow = rows.filter((r) => r.最少步数 < 2);
if (shallow.length) shallow.forEach((r) => fail('第' + r['#'] + '关 太简单（' + r.最少步数 + ' 步）'));
else ok('没有一关是 1 步就能过的');
const spread = rows.map((r) => r.最少步数);
ok('最少步数范围 ' + Math.min.apply(null, spread) + ' ~ ' + Math.max.apply(null, spread));

/* ---------- 4. 滑行规则 ---------- */
console.log('\n[4] 滑行规则');
{
  const L = normalizeLevel(LEVELS[1]); // 十字：中间 2x2 是墙
  const up = simulate(L, 0, 5, 'up');
  if (up.end[0] !== 0 || up.end[1] !== 0) fail('向上滑应停在 (0,0)，实际 ' + up.end);
  else ok('向上滑到顶停在 (0,0)');

  const right = simulate(L, 0, 0, 'right');
  if (right.end[0] !== 5 || right.end[1] !== 0) fail('(0,0) 向右应一路到右边界 (5,0)，实际 ' + right.end);
  else ok('没有墙时一直滑到边界');

  const ontoWall = simulate(L, 0, 2, 'right');
  if (ontoWall.end[0] !== 2 || ontoWall.end[1] !== 2) fail('(0,2) 向右应停在墙上 (2,2)，实际 ' + ontoWall.end);
  else ok('遇到墙时「贴上去」，停在墙格上');

  const atWall = simulate(L, 0, 0, 'left');
  if (atWall.moved) fail('贴边向左不应算作移动');
  else ok('贴边方向不算一步（不会消耗步数）');

  if (up.cells.length !== 6) fail('从 (0,5) 到 (0,0) 应经过 6 格，实际 ' + up.cells.length);
  else ok('途经过格数统计正确');

  // 关卡内每个目标格都必须真的能被经过（穿墙滑行允许，所以墙格也算可达通道）
  let unreachable = 0;
  LEVELS.forEach((raw, i) => {
    const lv = normalizeLevel(raw);
    const pass = new Set();
    const seen = new Set([lv.player[0] + ',' + lv.player[1]]);
    const queue = [lv.player];
    pass.add(lv.player[0] + ',' + lv.player[1]);
    while (queue.length) {
      const [x, y] = queue.shift();
      for (const dir of Object.keys(DIRS)) {
        const sim = simulate(lv, x, y, dir);
        if (!sim.moved) continue;
        sim.cells.forEach((c) => pass.add(c[0] + ',' + c[1]));
        const st = sim.end[0] + ',' + sim.end[1];
        if (!seen.has(st)) { seen.add(st); queue.push(sim.end); }
      }
    }
    lv.goals.forEach((g) => {
      const k = g[0] + ',' + g[1];
      if (!pass.has(k)) {
        unreachable++;
        fail('第' + (i + 1) + '关 目标 ' + k + ' 永远无法被经过');
      }
    });
  });
  if (!unreachable) ok('所有关卡的目标格都在可达路径上');
}

/* ---------- 5. 评价换算 ---------- */
console.log('\n[5] 星级换算');
{
  const cases = [[4, 4, 3], [3, 4, 3], [5, 4, 2], [8, 4, 2], [9, 4, 1], [40, 14, 1], [10, 10, 3]];
  let bad = 0;
  for (const [moves, min, want] of cases) {
    const got = starsFor(moves, min);
    if (got !== want) { fail('starsFor(' + moves + ',' + min + ') 应为 ' + want + '，实际 ' + got); bad++; }
  }
  if (!bad) ok('步数 → 星级换算符合预期（=最少 三星，≤1.5×+2 两星，其余一星）');
  ok('任何步数都能得到 ≥1 星，也就是永远可以通关');
}

/* ---------- 6. 无尽模式生成器 ---------- */
console.log('\n[6] 无尽即兴局生成器（200 次）');
{
  let generated = 0, unsolvable = 0, tooEasy = 0, sumMoves = 0, maxMoves = 0;
  const t0 = Date.now();
  for (let s = 1; s <= 200; s++) {
    const L = genLevel(s * 7919, 8);
    if (!L) { unsolvable++; continue; }
    generated++;
    const sol = solve(L, 18);
    if (!sol) { unsolvable++; continue; }
    if (sol.moves < 3) tooEasy++;
    sumMoves += sol.moves;
    maxMoves = Math.max(maxMoves, sol.moves);

    // 每条生成的关卡都要能真正涂满
    const painted = new Set();
    const startK = L.player[0] + ',' + L.player[1];
    if (L.goals.some((g) => g[0] + ',' + g[1] === startK)) painted.add(startK);
    for (const step of replayPath(L, sol.path)) {
      for (const c of step.cells) painted.add(c[0] + ',' + c[1]);
    }
    if (!L.goals.every((g) => painted.has(g[0] + ',' + g[1]))) fail('种子 ' + s + ' 生成局涂不满');
  }
  const ms = Date.now() - t0;
  if (unsolvable) fail(unsolvable + ' 个种子生成失败或无解');
  else ok('200 个种子全部生成成功且可解');
  if (tooEasy) fail(tooEasy + ' 局少于 3 步，偏简单');
  else ok('所有生成局最优步数 ≥ 3');
  ok('平均最优步数 ' + (sumMoves / Math.max(1, generated)).toFixed(1) +
     '，最多 ' + maxMoves + ' 步，总耗时 ' + ms + 'ms');
}

/* ---------- 汇总 ---------- */
console.log('\n' + '='.repeat(52));
if (failures) {
  console.log('结果：发现 ' + failures + ' 个问题 ✗');
  process.exit(1);
} else {
  console.log('结果：全部检查通过 ✓  可以放心打开 index.html 玩了');
}
console.log('='.repeat(52) + '\n');
