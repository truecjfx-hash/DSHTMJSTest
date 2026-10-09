/* ============================================================
   墨迹成行 · 真实浏览器截图（开发用）
   用法： node tools/screenshot.js [关卡号|inf] [输出文件]

   为什么不用 chrome --screenshot：
   那个模式对 file:// + 脚本的时序不可靠（实测截到的是脚本执行前的静态页面）。
   这里用 Node 自带的 WebSocket 直接讲 DevTools Protocol：
   连上 -> 导航 -> 等页面真正加载完 -> 用 JS 驱动游戏走几步 -> Page.captureScreenshot。
   无任何第三方依赖。
   ============================================================ */
'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const CHROME_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  path.join(os.homedir(), 'AppData\\Local\\Google\\Chrome\\Application\\chrome.exe'),
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
];

const chromePath = CHROME_CANDIDATES.find((p) => fs.existsSync(p));
if (!chromePath) {
  console.error('找不到 Chrome / Edge，无法截图');
  process.exit(1);
}

const which = process.argv[2] || '6';
const outFile = path.resolve(process.argv[3] || path.join(__dirname, '..', 'screenshot.png'));
// 注意：Chrome 会把一批端口列为 unsafe port（例如 9333），
// 用了它 /json/* 会拒绝服务，所以这里固定用一个安全端口 + 随机偏移。
const port = 9339 + Math.floor(Math.random() * 40);
const profile = path.join(os.tmpdir(), 'ink-shot-' + Date.now());
const pageUrl = 'file:///' + path.join(__dirname, '..', 'index.html').replace(/\\/g, '/') +
  (which === 'inf' ? '?endless=1&nointro=1' : '?level=' + which + '&nointro=1');

const chrome = spawn(chromePath, [
  '--headless=new',
  '--disable-gpu',
  '--hide-scrollbars',
  '--no-first-run',
  '--no-default-browser-check',
  '--user-data-dir=' + profile,
  '--remote-debugging-port=' + port,
  '--window-size=430,950',
  'about:blank'
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(pathname) {
  const res = await fetch('http://127.0.0.1:' + port + pathname);
  return res.json();
}

async function waitForChrome() {
  for (let i = 0; i < 80; i++) {
    try { return await getJson('/json/version'); }
    catch (e) { await sleep(150); }
  }
  throw new Error('Chrome 调试端口没起来');
}

async function main() {
  await waitForChrome();
  // 不加 /json/new（新版 Chrome 只接受 PUT），直接挑一个已有的空标签页来导航
  const list = await getJson('/json/list');
  const target = list.find((t) => t.type === 'page');
  if (!target) throw new Error('找不到可用的标签页');
  const ws = new WebSocket(target.webSocketDebuggerUrl);

  let nextId = 1;
  const pending = new Map();
  const events = [];

  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message));
      else resolve(msg.result);
    } else if (msg.method) {
      events.push(msg);
    }
  });

  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve);
    ws.addEventListener('error', () => reject(new Error('WebSocket 连接失败')));
  });

  const send = (method, params) => new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params: params || {} }));
  });

  await send('Page.enable');
  await send('Runtime.enable');

  const loaded = new Promise((resolve) => {
    const timer = setTimeout(resolve, 8000);
    const check = setInterval(() => {
      if (events.some((e) => e.method === 'Page.loadEventFired')) {
        clearInterval(check); clearTimeout(timer); resolve();
      }
    }, 50);
  });

  await send('Page.navigate', { url: pageUrl });
  await loaded;
  await sleep(600); // 等首帧渲染与关卡求解

  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error('页面脚本报错: ' + JSON.stringify(r.exceptionDetails.exception));
    return r.result.value;
  };

  // 收集页面里的 JS 异常 / 报错，最后一起报告
  const pageErrors = [];
  const collectErrors = setInterval(() => {
    while (events.length) {
      const e = events.shift();
      if (e.method === 'Runtime.exceptionThrown') {
        pageErrors.push(e.params.exceptionDetails.text + ' ' +
          (e.params.exceptionDetails.exception && e.params.exceptionDetails.exception.description || ''));
      } else if (e.method === 'Runtime.consoleAPICalled' && e.params.type === 'error') {
        pageErrors.push(e.params.args.map((a) => a.value || a.description).join(' '));
      }
    }
  }, 100);

  // 先确认页面真的活起来了，并把弹层关掉
  const info = await evaluate(`(() => {
    document.getElementById('help').hidden = true;
    document.getElementById('picker').hidden = true;
    document.getElementById('win').hidden = true;
    const tiles = document.querySelectorAll('#cells [data-key]');
    const help = document.getElementById('help');
    const cs = getComputedStyle(help);
    const r = help.getBoundingClientRect();
    const mid = document.elementFromPoint(innerWidth / 2, innerHeight / 2);
    return {
      level: document.getElementById('stat-level').textContent,
      total: document.getElementById('stat-total').textContent,
      moves: document.getElementById('stat-moves').textContent,
      tiles: tiles.length,
      path: location.search,
      helpHidden: help.hidden,
      helpDisplay: cs.display,
      helpOpacity: cs.opacity,
      helpRect: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)],
      midElement: mid ? (mid.id || mid.tagName + '.' + mid.className) : 'null',
      viewport: [innerWidth, innerHeight]
    };
  })()`);
  console.log('页面状态:', JSON.stringify(info, null, 1));

  if (info.tiles < 10) throw new Error('棋盘没有渲染出格子，截图没有意义');

  // 走几步，让画面里有墨迹 / 颜色变化（第 2 关的解法是 ↓→↑←）
  const moves = process.argv[4] ? process.argv[4].split(',') : ['ArrowDown', 'ArrowRight'];
  for (const k of moves) {
    await evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(k)}, bubbles: true }))`);
    await sleep(340);
  }

  const after = await evaluate(`({
    moves: document.getElementById('stat-moves').textContent,
    painted: document.getElementById('stat-painted').textContent,
    inkedTiles: Array.from(document.querySelectorAll('#cells [data-key]'))
      .filter(el => parseFloat(el.getAttribute('opacity')) > 0.3).length
  })`);
  console.log('走了 ' + moves.length + ' 步之后:', JSON.stringify(after));

  // 顺手点一下「提示」，确认不会抛异常、并给出一个方向
  await sleep(250);
  const hint = await evaluate(`(() => {
    document.getElementById('btn-hint').click();
    const t = document.getElementById('toast');
    return {
      toastHidden: t.hidden,
      toast: t.textContent,
      tip: document.getElementById('tip').textContent,
      rings: document.querySelectorAll('#ripples .ripple').length
    };
  })()`);
  console.log('提示功能:', JSON.stringify(hint, null, 1));
  if (hint.toastHidden && !/提示/.test(hint.tip)) {
    console.log('  ! 提示按钮没有给出任何反馈');
    process.exitCode = 3;
  }
  await sleep(200);

  const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  fs.writeFileSync(outFile, Buffer.from(shot.data, 'base64'));
  console.log('截图已保存: ' + outFile + ' (' + (fs.statSync(outFile).size / 1024).toFixed(1) + ' KB)');

  clearInterval(collectErrors);
  if (pageErrors.length) {
    console.log('页面报错 ' + pageErrors.length + ' 条:');
    pageErrors.forEach((e) => console.log('  ! ' + e));
    process.exitCode = 2;
  } else {
    console.log('页面无 JS 报错 ✓');
  }

  ws.close();
}

main()
  .catch((e) => { console.error('截图失败: ' + e.message); process.exitCode = 1; })
  .finally(() => {
    chrome.kill();
    setTimeout(() => {
      try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) { /* 忽略 */ }
      process.exit(process.exitCode || 0);
    }, 300);
  });
