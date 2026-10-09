/* ============================================================
   墨迹成行 · 无浏览器冒烟测试
   用法： node tests/smoke.js

   自己搭一个极小的 DOM / SVG 假环境，把 game.js 真正跑起来：
   启动、走完整关卡、悔棋、提示、重来、切关、无尽模式、存档，
   任何空引用 / 拼写错误都会在这里暴露。
   ============================================================ */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

let failures = 0;
const fail = (m) => { failures++; console.log('  ✗ ' + m); };
const ok = (m) => console.log('  ✓ ' + m);

/* ---------------- 迷你 DOM ---------------- */

const ELEMENT_IDS = [
  'board', 'stage', 'badge', 'tip', 'stat-level', 'stat-moves', 'stat-painted', 'stat-total', 'stat-stars',
  'btn-undo', 'btn-restart', 'btn-hint', 'btn-next', 'btn-levels', 'btn-help', 'btn-sound',
  'picker', 'level-grid', 'btn-picker-close', 'btn-endless',
  'help', 'btn-help-close', 'win', 'win-sub', 'win-stars', 'win-best',
  'btn-replay', 'btn-again', 'btn-win-next', 'toast'
];

class ClassList {
  constructor(el) { this.el = el; this.set = new Set(); }
  add(...c) { c.forEach((x) => this.set.add(x)); }
  remove(...c) { c.forEach((x) => this.set.delete(x)); }
  contains(c) { return this.set.has(c); }
  toggle(c, on) {
    const want = on === undefined ? !this.set.has(c) : !!on;
    if (want) this.set.add(c); else this.set.delete(c);
    return want;
  }
}

class FakeElement {
  constructor(tag, id) {
    this.tagName = String(tag || 'div').toUpperCase();
    this.id = id || '';
    this.children = [];
    this.parentNode = null;
    this.attributes = new Map();
    this.style = {
      _p: new Map(),
      setProperty(k, v) { this._p.set(k, v); },
      getPropertyValue(k) { return this._p.get(k); }
    };
    this.dataset = {};
    this.listeners = new Map();
    this.classList = new ClassList(this);
    this.hidden = false;
    this.disabled = false;
    this._text = '';
    this._html = '';
    this.value = '';
    this.type = '';
    this.firstChild = null;
  }

  get textContent() { return this._text; }
  set textContent(v) { this._text = String(v); }

  get innerHTML() { return this._html; }
  set innerHTML(v) { this._html = String(v); this.children = []; }

  setAttribute(k, v) { this.attributes.set(k, String(v)); }
  getAttribute(k) { return this.attributes.has(k) ? this.attributes.get(k) : null; }
  hasAttribute(k) { return this.attributes.has(k); }
  removeAttribute(k) { this.attributes.delete(k); }

  appendChild(child) {
    if (!child || typeof child !== 'object') throw new Error('appendChild 收到非法节点: ' + child);
    if (child.parentNode) child.parentNode.removeChild(child);
    child.parentNode = this;
    this.children.push(child);
    this.firstChild = this.children[0] || null;
    return child;
  }

  removeChild(child) {
    const i = this.children.indexOf(child);
    if (i < 0) throw new Error('removeChild: 节点不属于该父节点');
    this.children.splice(i, 1);
    child.parentNode = null;
    this.firstChild = this.children[0] || null;
    return child;
  }

  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(fn);
  }

  removeEventListener(type, fn) {
    const arr = this.listeners.get(type);
    if (arr) { const i = arr.indexOf(fn); if (i >= 0) arr.splice(i, 1); }
  }

  /** 触发事件（测试用） */
  dispatch(type, event) {
    const arr = this.listeners.get(type) || [];
    const ev = Object.assign({ type, target: this, preventDefault() {}, stopPropagation() {} }, event || {});
    arr.forEach((fn) => fn(ev));
    return ev;
  }

  setPointerCapture() {}
  releasePointerCapture() {}
  querySelector() { return null; }
}

/** 深度统计整棵树的节点数，确保 SVG 有真的在建 */
function countNodes(node) {
  let n = 1;
  for (const c of node.children) n += countNodes(c);
  return n;
}

/** 遍历 */
function walk(node, fn) {
  fn(node);
  node.children.forEach((c) => walk(c, fn));
}

/** 从棋盘里读出真实渲染出来的信息：
 *  - tiles:  格子染色层 data-key -> opacity（>0.3 视为已上色）
 *  - goals:  淡黄色目标格坐标集合
 *  - piece:  棋子的 transform
 *  - nums:   还留着的目标编号文字 */
function readBoard(board) {
  const tiles = new Map();
  const goals = new Set();
  const nums = [];
  let piece = null;
  walk(board, (n) => {
    if (n.tagName === 'RECT') {
      const k = n.dataset && n.dataset.key;
      if (k) tiles.set(k, parseFloat(n.getAttribute('opacity')));
      else if (n.getAttribute('fill') === '#dccdb2') {
        goals.add(Math.round((Number(n.getAttribute('x')) - 5) / 48) + ',' +
                  Math.round((Number(n.getAttribute('y')) - 5) / 48));
      }
    }
    if (n.tagName === 'TEXT') nums.push(n.textContent);
    if (n.getAttribute && n.getAttribute('id') === 'piece') piece = n.getAttribute('transform');
  });
  return {
    tiles, goals, nums, piece,
    paintedKeys: new Set(Array.from(tiles.entries()).filter(([, o]) => o > 0.3).map(([k]) => k))
  };
}

function setupDom() {
  const byId = new Map();
  const document = {
    readyState: 'complete',
    documentElement: new FakeElement('html'),
    createElement(tag) { return new FakeElement(tag); },
    createElementNS(ns, tag) { const e = new FakeElement(tag); e.ns = ns; return e; },
    getElementById(id) { return byId.get(id) || null; },
    addEventListener() {},
    querySelector() { return null; }
  };

  ELEMENT_IDS.forEach((id) => {
    const isBtn = id.startsWith('btn-');
    const el = new FakeElement(isBtn ? 'button' : 'div', id);
    el.hidden = true;   // 真实页面里这些弹层都带 hidden 属性
    byId.set(id, el);
  });
  // board 要是 svg，stage 承载指针事件
  byId.get('board').tagName = 'SVG';

  const rafQueue = [];
  let rafId = 1;
  const timeouts = new Map();
  let timeoutId = 1;

  const window = {
    addEventListener(type, fn) {
      if (!window._l) window._l = new Map();
      if (!window._l.has(type)) window._l.set(type, []);
      window._l.get(type).push(fn);
    },
    removeEventListener() {},
    dispatch(type, ev) {
      const arr = (window._l && window._l.get(type)) || [];
      const e = Object.assign({ type, preventDefault() {}, stopPropagation() {} }, ev || {});
      arr.forEach((fn) => fn(e));
      return e;
    },
    AudioContext: null,
    webkitAudioContext: null
  };

  // 让游戏里的滑行动画立刻收尾（浏览器在后台标签页会暂停 rAF，
  // 这里通过测试钩子跳过动画等待，模拟「动画播完」的状态）
  window.__DSH_TEST_SETTLE_MS = 1;

  const localStorageData = new Map();
  const localStorage = {
    getItem: (k) => (localStorageData.has(k) ? localStorageData.get(k) : null),
    setItem: (k, v) => localStorageData.set(k, String(v)),
    removeItem: (k) => localStorageData.delete(k),
    clear: () => localStorageData.clear()
  };

  const context = {
    window, document, localStorage, console,
    setTimeout(fn, ms) { const id = timeoutId++; timeouts.set(id, { fn, ms: ms || 0 }); return id; },
    clearTimeout(id) { timeouts.delete(id); },
    setInterval() { return 0; },
    clearInterval() {},
    requestAnimationFrame(fn) { const id = rafId++; rafQueue.push({ id, fn }); return id; },
    cancelAnimationFrame(id) {
      const i = rafQueue.findIndex((r) => r.id === id);
      if (i >= 0) rafQueue.splice(i, 1);
    },
    performance: { now: () => Date.now() },
    Math, JSON, Date, Object, Array, Set, Map, Number, String, Boolean, Error, isNaN, parseInt, parseFloat
  };
  context.globalThis = context;
  context.self = context;

  /** 把排队中的 rAF 与到期的定时器交替跑完（限制轮数，避免死循环）。
   *  动画收尾是靠 setTimeout 兜底的，所以两者必须交替推进。 */
  const flushRaf = (maxRounds) => {
    let rounds = 0;
    const limit = maxRounds || 400;
    while ((rafQueue.length || timeouts.size) && rounds < limit) {
      const batch = rafQueue.splice(0, rafQueue.length);
      batch.forEach((r) => r.fn(context.performance.now()));
      const due = Array.from(timeouts.entries());
      timeouts.clear();
      due.forEach(([, t]) => t.fn());
      rounds++;
    }
    return rounds;
  };

  /** 只跑定时器（用于检查延迟行为） */
  const flushTimeouts = (maxRounds) => {
    let rounds = 0;
    while (timeouts.size && rounds < (maxRounds || 400)) {
      const entries = Array.from(timeouts.entries());
      timeouts.clear();
      entries.forEach(([, t]) => t.fn());
      rounds++;
    }
    return rounds;
  };

  return { context, byId, rafQueue, flushRaf, flushTimeouts, timeouts, localStorageData };
}

/* ---------------- 启动游戏 ---------------- */

function bootGame() {
  const dom = setupDom();
  const src = fs.readFileSync(path.join(__dirname, '..', 'game.js'), 'utf8');
  vm.createContext(dom.context);
  vm.runInContext(src, dom.context, { filename: 'game.js' });
  return dom;
}

const dirsOf = (d) => ({ up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight' }[d]);

/* ---------------- 测试 ---------------- */

console.log('\n[1] 启动');
let dom;
try {
  dom = bootGame();
  ok('game.js 在假 DOM 里成功启动，没有抛异常');
} catch (e) {
  fail('启动就炸了：' + e.message + '\n' + e.stack);
  process.exit(1);
}

const { byId, context, flushRaf, flushTimeouts } = dom;

{
  const board = byId.get('board');
  if (!board.children.length) fail('棋盘 SVG 没有任何内容');
  else ok('棋盘已渲染，节点数 ' + countNodes(board));
  if (board.getAttribute('viewBox') === null) fail('viewBox 未设置');
  else ok('viewBox = ' + board.getAttribute('viewBox'));
  if (byId.get('stat-level').textContent !== '1') fail('开局应显示第 1 关');
  else ok('HUD 显示第 1 关');
  if (byId.get('stat-total').textContent !== '7') fail('第 1 关目标数应为 7，实际 ' + byId.get('stat-total').textContent);
  else ok('目标总数正确（第 1 关 7 个）');
  if (!byId.get('help').hidden) ok('首次打开自动弹出玩法说明');
}

console.log('\n[2] 弹层拦截 → 按键响应与撞墙');
{
  // 首次进入会弹出玩法说明，此时方向键不应该让棋子动（避免误操作）
  if (byId.get('help').hidden) fail('本应弹出玩法说明');
  context.window.dispatch('keydown', { key: 'ArrowLeft' });
  flushRaf();
  if (byId.get('stat-moves').textContent !== '0') fail('玩法说明还开着，方向键不应该生效');
  else ok('玩法说明开着时方向键被正确拦截');

  context.window.dispatch('keydown', { key: 'Escape' });
  context.window.dispatch('keydown', { key: 'Escape' }); // 说明层是最后关的，多按一次无副作用
  if (!byId.get('help').hidden) { byId.get('btn-help-close').dispatch('click'); }
  flushRaf();
  if (!byId.get('help').hidden) fail('玩法说明关不掉');
  else ok('玩法说明可以关闭');

  const before = byId.get('stat-moves').textContent;
  const beforeBoard = readBoard(byId.get('board'));
  context.window.dispatch('keydown', { key: 'ArrowLeft' });
  flushRaf();
  const moved = byId.get('stat-moves').textContent;
  if (moved === before) fail('按方向键没有记步数');
  else ok('按 ← 走了一步（' + before + ' → ' + moved + '）');

  const painted = Number(byId.get('stat-painted').textContent);
  if (painted <= 0) fail('滑过格子后没有涂色');
  else ok('滑过的格子已涂色（已涂 ' + painted + '）');

  // 关键：HUD 说涂了色，棋盘上的格子也必须真的被染色（这一条曾经漏过 bug）
  const afterBoard = readBoard(byId.get('board'));
  const grew = afterBoard.paintedKeys.size > beforeBoard.paintedKeys.size;
  if (!grew) fail('HUD 记了涂色，但棋盘上的格子没有被染色（视觉与逻辑脱节）');
  else ok('棋盘上真的染了 ' + afterBoard.paintedKeys.size + ' 个格子（视觉与逻辑一致）');
  if (afterBoard.piece === null) fail('找不到棋子节点');
  else ok('棋子已定位：' + afterBoard.piece);

  // 撞墙不计步数
  let bumped = false;
  for (let i = 0; i < 4; i++) {
    const m = Number(byId.get('stat-moves').textContent);
    context.window.dispatch('keydown', { key: 'ArrowUp' });
    flushRaf();
    if (Number(byId.get('stat-moves').textContent) === m) { bumped = true; break; }
  }
  if (!bumped) fail('贴边滑动应该不计步数，但每次都记了');
  else ok('贴边 / 撞墙方向不消耗步数');
}

console.log('\n[3] 悔棋 / 重来');
{
  // 用求解器算出的方向按键，保证每一步都是有效移动
  const G = require(path.join(__dirname, '..', 'game.js'));
  const L = G.normalizeLevel(G.LEVELS[0]);
  let x = L.player[0], y = L.player[1];
  const myPainted = new Set();
  if (L.goals.some((g) => g[0] === x && g[1] === y)) myPainted.add(x + ',' + y);

  const doMove = (dir) => {
    const sim = G.simulate(L, x, y, dir);
    sim.cells.forEach((c) => myPainted.add(c[0] + ',' + c[1]));
    x = sim.end[0]; y = sim.end[1];
    context.window.dispatch('keydown', { key: dirsOf(dir) });
    flushRaf();
  };

  const beforeUndo = Number(byId.get('stat-moves').textContent);
  const beforePainted = Number(byId.get('stat-painted').textContent);
  const domBefore = readBoard(byId.get('board')).paintedKeys;
  doMove('down');
  const afterMove = Number(byId.get('stat-moves').textContent);
  if (afterMove !== beforeUndo + 1) fail('有效移动应只 +1 步（' + beforeUndo + ' → ' + afterMove + '）');
  else ok('每按一次方向键只走一步（' + beforeUndo + ' → ' + afterMove + '）');

  context.window.dispatch('keydown', { key: 'z' });
  flushRaf();
  const afterUndo = Number(byId.get('stat-moves').textContent);
  if (afterUndo !== afterMove - 1) fail('按 z 悔棋后步数应为 ' + (afterMove - 1) + '，实际 ' + afterUndo);
  else ok('按 z 悔棋回退一步（' + afterMove + ' → ' + afterUndo + '）');
  if (Number(byId.get('stat-painted').textContent) !== beforePainted) {
    fail('悔棋后已涂数应回到 ' + beforePainted + '，实际 ' + byId.get('stat-painted').textContent);
  } else ok('悔棋后已涂格数也一起回退（' + beforePainted + '）');

  // 悔棋后棋盘上的染色也必须还原
  const domAfter = readBoard(byId.get('board')).paintedKeys;
  const extra = Array.from(domAfter).filter((k) => !domBefore.has(k));
  if (extra.length) fail('悔棋后棋盘上仍留着应被撤销的染色：' + extra.join(' '));
  else ok('悔棋后棋盘染色同步还原（' + domAfter.size + ' 格）');

  // 用「悔一步」按钮再验一次
  doMove('right');
  const beforeBtn = Number(byId.get('stat-moves').textContent);
  byId.get('btn-undo').dispatch('click');
  flushRaf();
  if (Number(byId.get('stat-moves').textContent) !== beforeBtn - 1) fail('「悔一步」按钮无效');
  else ok('「悔一步」按钮同样有效');

  // 重来
  doMove('right');
  context.window.dispatch('keydown', { key: 'r' });
  flushRaf();
  const afterRestart = Number(byId.get('stat-painted').textContent);
  const startPainted = L.goals.some((g) => g[0] === L.player[0] && g[1] === L.player[1]) ? 1 : 0;
  if (afterRestart !== startPainted) fail('重来后已涂数应为 ' + startPainted + '，实际 ' + afterRestart);
  else ok('重来把进度清空（已涂 ' + afterRestart + '）');
  if (Number(byId.get('stat-moves').textContent) !== 0) fail('重来后步数应归零');
  else ok('重来后步数归零');
}

console.log('\n[4] 自动通关（按求解器给出的解法按键）');
{
  const board = byId.get('board');
  const G = require(path.join(__dirname, '..', 'game.js')); // 纯逻辑，不碰 DOM

  // 明确地选「第 2 关」，不依赖上一节停在哪儿
  byId.get('btn-levels').dispatch('click');
  flushRaf();
  byId.get('level-grid').children[1].dispatch('click');
  flushRaf();
  const startLevelNo = byId.get('stat-level').textContent;
  if (startLevelNo !== '2') fail('切换第 2 关失败，当前第 ' + startLevelNo + ' 关');
  else ok('已切到第 2 关（棋盘节点数 ' + countNodes(board) + '）');

  const L1 = G.normalizeLevel(G.LEVELS[1]);
  const sol = G.solve(L1, 16);
  const hudTotal = Number(byId.get('stat-total').textContent);
  if (hudTotal !== L1.goals.length) fail('HUD 目标数与关卡数据不一致（' + hudTotal + ' vs ' + L1.goals.length + '）');
  else ok('HUD 目标数与关卡数据一致（' + hudTotal + ' 个）');

  if (!sol) fail('第 2 关求解失败');
  else {
    let rejected = 0;
    let ghost = 0;
    for (const d of sol.path) {
      const before = Number(byId.get('stat-moves').textContent);
      context.window.dispatch('keydown', { key: dirsOf(d) });
      flushRaf();
      if (Number(byId.get('stat-moves').textContent) === before) rejected++;
      // 每一步走完，HUD 的已涂数必须和棋盘上的染色格数一致
      const dom = readBoard(board);
      const domGoalPainted = Array.from(dom.goals).filter((k) => dom.paintedKeys.has(k)).length;
      if (domGoalPainted !== Number(byId.get('stat-painted').textContent)) ghost++;
    }
    if (rejected) fail('解法里有 ' + rejected + ' 步被游戏拒绝（说明规则和求解器不一致）');
    else ok('解法里的 ' + sol.path.length + ' 步全部被接受');
    if (ghost) fail('有 ' + ghost + ' 步出现「HUD 已涂数」与「棋盘染色」不一致');
    else ok('每一步的 HUD 计数都和棋盘染色一致');

    const total = Number(byId.get('stat-total').textContent);
    const painted = Number(byId.get('stat-painted').textContent);
    if (painted !== total) fail('按解法走完却没涂满（' + painted + '/' + total + '）');
    else ok('按 ' + sol.path.length + ' 步解法走完，' + painted + '/' + total + ' 全部涂满');

    // 棋盘上每个目标格都必须真的染色了
    const board4 = readBoard(board);
    const missing = Array.from(board4.goals).filter((k) => !board4.paintedKeys.has(k));
    if (missing.length) fail('过关了但棋盘上还有没染色的目标格：' + missing.join(' '));
    else ok('棋盘上 ' + board4.goals.size + ' 个目标格全部染色');
    if (board4.nums.length) fail('涂过的目标格应该没有编号了，还剩 ' + JSON.stringify(board4.nums));
    else ok('涂过的目标编号已消失');
    if (byId.get('win').hidden) fail('过关后面板没有显示');
    else ok('过关面板显示，评价 = ' + byId.get('win-stars').innerHTML.replace(/<[^>]+>/g, ''));
    if (!/步/.test(byId.get('win-sub').textContent)) fail('过关面板没有步数信息');
    else ok('过关信息：' + byId.get('win-sub').textContent);
    if (Number(byId.get('stat-moves').textContent) !== sol.path.length) {
      fail('步数统计与解法长度不一致');
    } else ok('步数统计准确（' + sol.path.length + ' 步 = 理论最少，应为三星）');
    if (byId.get('stat-stars').textContent !== '★★★') fail('最少步通关应记三星，实际 ' + byId.get('stat-stars').textContent);
    else ok('最佳记录写入三星：' + byId.get('stat-stars').textContent);

    byId.get('btn-win-next').dispatch('click');
    flushRaf();
    if (byId.get('stat-level').textContent !== String(Number(startLevelNo) + 1)) {
      fail('点下一关没有正确切换');
    } else ok('切到第 ' + byId.get('stat-level').textContent + ' 关，棋盘节点数 ' + countNodes(board));
  }
}

console.log('\n[5] 提示 / 弹层 / 无尽模式');
{
  byId.get('btn-hint').dispatch('click');
  flushTimeouts(50);
  flushRaf();
  ok('点提示没有报错，tip = 「' + byId.get('tip').textContent + '」');

  byId.get('btn-levels').dispatch('click');
  if (byId.get('picker').hidden) fail('点「关卡」没有打开选择面板');
  else ok('关卡选择面板打开，按钮数 ' + byId.get('level-grid').children.length);
  byId.get('btn-picker-close').dispatch('click');
  if (!byId.get('picker').hidden) fail('选择面板关不上');
  else ok('选择面板可以关闭');

  byId.get('btn-endless').dispatch('click');
  flushRaf();
  if (byId.get('stat-level').textContent !== '∞') fail('无尽模式关卡号应显示 ∞，实际 ' + byId.get('stat-level').textContent);
  else ok('无尽即兴局启动，关卡号 ∞，目标 ' + byId.get('stat-total').textContent + ' 个');
  if (byId.get('badge').hidden) fail('无尽模式应显示「即兴局」角标');
  else ok('角标提示正常');
  if (byId.get('btn-hint').disabled) fail('无尽模式下提示按钮不应被禁用');
  else ok('提示按钮可用');
  if (!byId.get('btn-next').disabled) fail('无尽模式下「下一关」应被禁用（没有「下一关」）');
  else ok('无尽模式下「下一关」按钮已禁用');
}

console.log('\n[6] 音效开关 / 存档');
{
  byId.get('btn-sound').dispatch('click');
  if (byId.get('btn-sound').textContent.indexOf('关') < 0) fail('音效按钮没有切换文案');
  else ok('音效按钮可切换（' + byId.get('btn-sound').textContent + '）');
  byId.get('btn-sound').dispatch('click');

  const saved = dom.localStorageData.get('ink-drift.save.v1');
  if (!saved) fail('没有写入存档');
  else {
    let parsed = null;
    try { parsed = JSON.parse(saved); } catch (e) { fail('存档不是合法 JSON'); }
    if (parsed) ok('存档已写入：' + saved.slice(0, 80));
  }
}

console.log('\n[7] 12 关全部能渲染');
{
  const board = byId.get('board');
  let bad = 0;
  for (let i = 0; i < 12; i++) {
    context.window.dispatch('keydown', { key: 'Escape' });
    flushRaf();
    byId.get('btn-levels').dispatch('click');
    const grid = byId.get('level-grid');
    if (grid.children.length !== 12) { fail('关卡面板应有 12 个按钮，实际 ' + grid.children.length); bad++; break; }
    grid.children[i].dispatch('click');
    flushRaf();
    const nodes = countNodes(board);
    if (nodes < 20) { fail('第 ' + (i + 1) + ' 关棋盘节点太少 (' + nodes + ')'); bad++; }
  }
  if (!bad) ok('12 关逐一切换，棋盘全部渲染正常');
}

console.log('\n[8] 内存/清理');
{
  // 反复切关，确认不会残留大量节点（涟漪层应被清理）
  const board = byId.get('board');
  for (let i = 0; i < 8; i++) {
    byId.get('btn-restart').dispatch('click');
    flushRaf();
  }
  const n = countNodes(board);
  if (n > 4000) fail('反复重来后节点数异常膨胀：' + n);
  else ok('反复重来 8 次，节点数稳定在 ' + n);
}

console.log('\n[9] 逐关自动通关（12 关，边玩边核对棋盘染色）');
{
  const G = require(path.join(__dirname, '..', 'game.js'));
  const board = byId.get('board');
  let bad = 0;
  const summary = [];

  for (let i = 0; i < 12; i++) {
    byId.get('btn-levels').dispatch('click');
    flushRaf();
    byId.get('level-grid').children[i].dispatch('click');
    flushRaf();

    const L = G.normalizeLevel(G.LEVELS[i]);
    const sol = G.solve(L, 20);
    if (!sol) { fail('第 ' + (i + 1) + ' 关无解，无法自动通关'); bad++; continue; }

    // 自己同步一份预期状态，用来核对游戏
    let x = L.player[0], y = L.player[1];
    const mine = new Set();
    if (L.goals.some((g) => g[0] === x && g[1] === y)) mine.add(x + ',' + y);

    let mismatch = 0;
    for (const d of sol.path) {
      const sim = G.simulate(L, x, y, d);
      sim.cells.forEach((c) => mine.add(c[0] + ',' + c[1]));
      x = sim.end[0]; y = sim.end[1];
      context.window.dispatch('keydown', { key: dirsOf(d) });
      flushRaf();

      const dom = readBoard(board);
      const domGoalsPainted = Array.from(dom.goals).filter((k) => dom.paintedKeys.has(k)).length;
      const expectGoalsPainted = L.goals.filter((g) => mine.has(g[0] + ',' + g[1])).length;
      if (domGoalsPainted !== expectGoalsPainted) mismatch++;
      if (Number(byId.get('stat-moves').textContent) !== sol.path.length && domGoalsPainted === expectGoalsPainted) {
        // 步数是逐步累加的，这里只在最后统一核对
      }
    }

    const dom = readBoard(board);
    const domGoalsPainted = Array.from(dom.goals).filter((k) => dom.paintedKeys.has(k)).length;
    const solvedShown = !byId.get('win').hidden;
    const numsLeft = dom.nums.length;
    const okLevel = mismatch === 0 && domGoalsPainted === L.goals.length && solvedShown && numsLeft === 0 &&
      Number(byId.get('stat-moves').textContent) === sol.path.length;

    summary.push({
      关卡: i + 1, 名称: L.name, 尺寸: L.w + '×' + L.h,
      目标: L.goals.length, 最少步数: sol.path.length,
      实际步数: byId.get('stat-moves').textContent,
      棋盘染色: domGoalsPainted + '/' + L.goals.length,
      过关面板: solvedShown ? '是' : '否',
      残留编号: numsLeft,
      结果: okLevel ? 'OK' : '失败'
    });
    if (!okLevel) { fail('第 ' + (i + 1) + ' 关 <' + L.name + '> 自动通关核对失败'); bad++; }
    else ok('第 ' + (i + 1) + ' 关 <' + L.name + '> ' + sol.path.length + ' 步通关，棋盘染色一致');

    if (!byId.get('win').hidden) { byId.get('btn-win-next').dispatch('click'); flushRaf(); }
  }

  if (!bad) {
    ok('12 关全部按最优解自动通关，且每一步的棋盘染色都与逻辑一致');
    console.table(summary);
  }
}

console.log('\n' + '='.repeat(52));
if (failures) {
  console.log('结果：发现 ' + failures + ' 个问题 ✗');
  process.exit(1);
} else {
  console.log('结果：冒烟测试全部通过 ✓');
}
console.log('='.repeat(52) + '\n');
