import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const base = fileURLToPath(new URL('../dist/webview/', import.meta.url));
const output = process.env.CODE_MAP_TEST_ROOT ?? join(tmpdir(), 'code-map-vscode');
await mkdir(output, {recursive:true});
const profile = await mkdtemp(join(output, 'webview-profile-'));
const executable = [process.env.CHROMIUM_PATH, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find(value => value && existsSync(value));
if (!executable) throw new Error('Set CHROMIUM_PATH to a Chromium or Chrome executable to run the webview checks.');
const assets = {
  '/graph.js': ['text/javascript', await readFile(base + 'graph.js')],
  '/graph.css': ['text/css', await readFile(base + 'graph.css')],
};
const html = `<!doctype html><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-smoke'; style-src 'self'; style-src-attr 'unsafe-inline'; worker-src blob:; connect-src 'none';">
<link rel="stylesheet" href="/graph.css"><div id="root"></div><script nonce="smoke" defer src="/graph.js"></script>`;
const chrome = spawn(executable,
  ['--headless', '--remote-debugging-pipe', '--disable-dev-shm-usage', `--user-data-dir=${profile}`, 'about:blank'],
  { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] });
const awaiting = new Map();
const events = [];
const exited = new Promise(resolve => chrome.once('exit', resolve));
let id = 0;
let buffer = '';
chrome.stdio[4].setEncoding('utf8');
chrome.stdio[4].on('data', (chunk) => {
  buffer += chunk;
  for (let n; (n = buffer.indexOf('\0')) >= 0;) {
    const msg = JSON.parse(buffer.slice(0, n));
    buffer = buffer.slice(n + 1);
    if (msg.id) {
      const callback = awaiting.get(msg.id);
      awaiting.delete(msg.id);
      msg.error ? callback?.reject(msg.error) : callback?.resolve(msg.result);
    } else if (msg.method) {
      events.push(msg);
      if (msg.method === 'Fetch.requestPaused') {
        const path = new URL(msg.params.request.url).pathname;
        const [type, body] = assets[path] ?? ['text/html', html];
        void cdp('Fetch.fulfillRequest', {
          requestId: msg.params.requestId, responseCode: 200,
          responseHeaders: [{ name: 'Content-Type', value: type }],
          body: Buffer.from(body).toString('base64'),
        }, msg.sessionId);
      }
    }
  }
});
chrome.on('exit', (code) => {
  for (const { reject } of awaiting.values()) reject(new Error('Chromium exited with code ' + code));
  awaiting.clear();
});
chrome.stderr.on('data', (chunk) => {
  if (String(chunk).includes('FATAL')) process.stderr.write(chunk);
});

function cdp(method, params = {}, sessionId) {
  const command = { id: ++id, method, params, sessionId };
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      awaiting.delete(command.id);
      reject(new Error('Timed out: ' + method));
    }, 7000);
    awaiting.set(command.id, {
      resolve: (value) => { clearTimeout(timeout); resolve(value); },
      reject: (error) => { clearTimeout(timeout); reject(error); },
    });
    chrome.stdio[3].write(JSON.stringify(command) + '\0');
  });
}

const graph = {
  root: '/fixture',
  nodes: ['src/main.ts', 'src/data.ts', 'src/routes.ts'].map(id => ({
    id, extension: '.ts', sizeBytes: 10, exports: [], isEntryPoint: id === 'src/main.ts', folder: 'src',
  })),
  edges: [3, 6].map(line => ({
    source: 'src/main.ts', target: 'src/data.ts', importedSymbols: ['data'],
    isTypeOnly: false, inCycle: false, line,
  })),
  endpoints: [{ id: 'endpoint::GET /remote', method: 'GET', url: '/remote' }],
  apiCalls: [
    { id: 'src/main.ts::GET::/data', source: 'src/main.ts', target: 'src/routes.ts',
      method: 'GET', url: '/data', client: 'fetch', line: 15, targetLine: 8, isDynamic: false },
    { id: 'src/main.ts::GET::/remote', source: 'src/main.ts', target: 'endpoint::GET /remote',
      method: 'GET', url: '/remote', client: 'fetch', line: 18, isDynamic: false },
  ],
  routes: [{ file: 'src/routes.ts', method: 'GET', path: '/data', line: 8 }],
  cycles: [],
  stats: { fileCount: 3, edgeCount: 2, cycleCount: 0, skippedFiles: 0, apiCallCount: 2, routeCount: 1 },
};
const state = {
  workspaceName: 'Fixture', workspaceId: 'fixture', graph, revision: 1,
  refreshing: false, dirty: false, error: null, activeFileId: null,
};

let session;
async function evaluate(expression) {
  const response = await cdp('Runtime.evaluate', { expression, alignResult: true, returnByValue: true, awaitPromise: true }, session);
  if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description);
  return response.result.value;
}
async function eventually(expectation, predicate) {
  for (let retries = 0; retries < 42; retries++) {
    const value = await evaluate(predicate);
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(expectation + '\n' + await evaluate('document.body.innerText'));
}
const emit = (message) => evaluate('window.emit(' + JSON.stringify(message) + ')');
const emitState = (overrides) => emit({ type: 'state', state: { ...state, ...overrides } });
const click = (label) => evaluate(`[...document.querySelectorAll('button')].find(x => x.innerText.includes(${JSON.stringify(label)})).click()`);
const file = (fileId) => evaluate(`(s => { s.value = ${JSON.stringify(fileId)}; s.dispatchEvent(new Event('change', {bubbles:true})); })(document.querySelector('select'))`);
const message = (type) => evaluate(`window.messages.filter(x => x.type === ${JSON.stringify(type)}).at(-1)`);

try {
  const { targetInfos } = await cdp('Target.getTargets');
  ({ sessionId: session } = await cdp('Target.attachToTarget', { targetId: targetInfos.find(x => x.type === 'page').targetId, flatten: true }));
  await cdp('Runtime.enable', {}, session);
  await cdp('Page.enable', {}, session);
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1024, height: 720, deviceScaleFactor: 1, mobile: false }, session);
  await cdp('Page.addScriptToEvaluateOnNewDocument', { source: `
    window.messages = [];

    window.violations = [];
    window.acquireCount = 0;
    window.settings = undefined;
    window.emit = (data) => dispatchEvent(new MessageEvent('message', {data}));
    addEventListener('securitypolicyviolation', (event) => violations.push(event.violatedDirective + ':' + event.blockedURI));
    window.acquireVsCodeApi = () => {
      acquireCount += 1;
      return {
        getState: () => settings,
        setState: (value) => settings = value,
        postMessage: (value) => {
          messages.push(value);
          if (value.type === 'ready') window.emit({type:'state', state:${JSON.stringify(state)}});
        }
      };
    };
    window.workerUrls = [];
    const NativeWorker = Worker;
    window.Worker = class extends NativeWorker {
      constructor(url, options) {
        super(url, options);
        workerUrls.push(url.toString());
      }
    };
    window.graphLabels = {};
    const draw = CanvasRenderingContext2D.prototype.fillText;
    CanvasRenderingContext2D.prototype.fillText = function(text,x,y,...args) {
      if(this.canvas.isConnected) {
        const t = this.getTransform();
        const rect = this.canvas.getBoundingClientRect();
        graphLabels[text] = {x: rect.x + (t.a*x+t.e), y: rect.y + (t.d*y+t.f), zoom:t.a};
      }
      return draw.call(this,text,x,y,...args);
    };
  ` }, session);
  await cdp('Fetch.enable', { patterns: [{ urlPattern: 'https://code-map.test/*' }] }, session);
  await cdp('Page.navigate', { url: 'https://code-map.test/' }, session);
  await eventually('graph drew main label through CSP', 'window.graphLabels?.["main.ts"]');
  assert.equal(await evaluate('window.acquireCount'), 1);
  assert.match((await evaluate('window.workerUrls'))[0], /^blob:/);
  assert.deepEqual(await evaluate('window.violations'), []);
  assert.deepEqual((await evaluate('window.messages')).map(x => x.type), ['ready']);
  await new Promise(resolve => setTimeout(resolve, 1100));
  const node = await evaluate('window.graphLabels["main.ts"]');

 await cdp('Page.captureScreenshot',{format:'png'},session).then(async({data})=>(await import('node:fs/promises')).writeFile(join(output, 'webview-initial.png'),Buffer.from(data,'base64')));
  await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: node.x, y: node.y + 2 }, session);
  await new Promise(resolve => setTimeout(resolve, 300)); await eventually('canvas pointer hit-test is ready', 'document.querySelector("canvas").classList.contains("clickable")');
  await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', buttons: 1, pointerType:'mouse', clickCount: 1, x: node.x, y: node.y + 2 }, session);
  await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', buttons: 0, pointerType:'mouse', clickCount: 1, x: node.x, y: node.y + 2 }, session);
  await eventually('file clicked in canvas', 'document.querySelector("select").value === "src/main.ts"');
  assert.deepEqual(await message('open'), { type: 'open', location: { fileId: 'src/main.ts', preserveFocus: true } });
  let pending = await message('symbols');
  await emit({ type: 'symbols', fileId: pending.fileId, requestId: pending.requestId + 1, revision: 1,
    graph: { file: pending.fileId, nodes: [{ id:'stale', name:'stale', kind:'function', startLine:3 }], edges: [] }, error: null });
  assert.equal(await evaluate('document.body.innerText.includes("stale")'), false);
  await emit({ type: 'symbols', fileId: pending.fileId, requestId: pending.requestId, revision: 1,
    graph: { file: pending.fileId, nodes: [{ id:'run', name:'run', kind:'function', startLine:22 }], edges: [] }, error: null });
  await eventually('symbol rendered', 'document.body.innerText.includes("Line 22")');
  await cdp('Page.captureScreenshot', {format:'png'}, session).then(async({data})=>(await import('node:fs/promises')).writeFile(join(output, 'webview-desktop.png'),Buffer.from(data,'base64')));
  await click('run');
  assert.deepEqual(await message('open'), { type: 'open', location: { fileId: 'src/main.ts', line: 22, preserveFocus: false } });
  await eventually('duplicate import edges both available', '[...document.querySelectorAll("button")].filter(x => x.innerText.includes("src/data.ts")).length === 2');
  await click('Import · Line 6');
  await eventually('import navigation shows up', 'document.body.innerText.includes("Open import")');
  await click('Open import');
  assert.equal((await message('open')).location.line, 6);
  await click('Open target file');
  assert.equal((await message('open')).location.fileId, 'src/data.ts');
  await file('src/main.ts');
  await eventually('main file details reselected', 'document.body.innerText.includes("GET /data")');
  await click('GET /data');
  await eventually('route navigation shows up', 'document.body.innerText.includes("Open GET /data route")');
  await click('Open call site');
  assert.equal((await message('open')).location.line, 15);
  await click('Open GET /data route');
  assert.deepEqual((await message('open')).location, { fileId:'src/routes.ts', line:8, preserveFocus:false });

  const callsBeforeFollow = await evaluate('messages.filter(x => x.type === "open").length');
  await emitState({ activeFileId: 'src/routes.ts', dirty: true });
  await eventually('editor following selects active file', 'document.querySelector("select").value === "src/routes.ts"');
  assert.equal(await evaluate('messages.filter(x => x.type === "open").length'), callsBeforeFollow);
  assert.match(await evaluate('document.body.innerText'), /Unsaved changes/);
  await evaluate('document.querySelector("input[type=checkbox]").click()');
  assert.deepEqual(await evaluate('window.settings'), { followEditor: false });
  await emitState({ activeFileId: 'src/data.ts', refreshing: true });
  await eventually('refreshing status visible', 'document.body.innerText.includes("Refreshing saved files")');
  assert.equal(await evaluate('document.querySelector("select").value'), 'src/routes.ts');

  await cdp('Input.dispatchMouseEvent', { type: 'mouseWheel', x: node.x, y: node.y, deltaX: 0, deltaY: 360 }, session);
  const zoomed = await eventually('mouse wheel changed zoom', `Math.abs(window.graphLabels["main.ts"].zoom - ${node.zoom}) > 0.01 && window.graphLabels["main.ts"].zoom`);
  await emitState({ revision: 2, activeFileId: 'src/data.ts', graph: { ...graph, nodes: graph.nodes.map(node => ({...node,sizeBytes:20})) } });
  await new Promise(resolve => setTimeout(resolve, 500));
  assert.equal(await evaluate('window.graphLabels["main.ts"].zoom'), zoomed, 'viewport persists across refreshed snapshot');
  assert.equal(await evaluate('document.querySelector("select").value'), 'src/routes.ts', 'selection persists across refreshed snapshot');
  await click('Fit');
  await eventually('fit changes zoom', `Math.abs(window.graphLabels["main.ts"].zoom - ${zoomed}) > 0.01`);

  await emitState({ graph: null, revision: 2, error: 'Synthetic analysis error' });
  await eventually('error message for retained graph', 'document.body.innerText.includes("Showing the last saved snapshot")');
  assert.equal(await evaluate('document.querySelectorAll("canvas").length'), 1);
  await click('Retry');
  assert.equal((await message('refresh')).type, 'refresh');
  await click('Switch workspace');
  assert.equal((await message('chooseWorkspace')).type, 'chooseWorkspace');
  await emit({ type:'navigationError', message:'Source unavailable' });
  await eventually('navigation error visible', 'document.body.innerText.includes("Source unavailable")');
  await click('Dismiss');

  await cdp('Emulation.setDeviceMetricsOverride', { width: 375, height: 670, deviceScaleFactor: 1, mobile: false }, session);
  await eventually('narrow layout has no horizontal overflow', 'document.documentElement.scrollWidth === 375 && document.querySelector(".inspector").offsetTop > document.querySelector(".map-pane").offsetTop');
  await cdp('Page.captureScreenshot', { format: 'png' }, session).then(({data}) =>
    import('node:fs/promises').then(({writeFile}) => writeFile(join(output, 'webview-narrow.png'), Buffer.from(data,'base64'))));
  await emitState({ workspaceId:'new', workspaceName:'New', graph:{...graph,nodes:[],edges:[],apiCalls:[],endpoints:[]} });
  await eventually('empty workspace message visible', 'document.body.innerText.includes("No supported JavaScript or TypeScript files found")');
  assert.equal(await evaluate('document.querySelectorAll("canvas").length'), 0);
  assert.deepEqual(await evaluate('window.violations'), []);
  assert.deepEqual(events.filter(x => x.method === 'Runtime.exceptionThrown').map(x => x.params.exceptionDetails.text), []);
  await (await import('node:fs/promises')).writeFile(join(output, 'webview-results.json'), JSON.stringify({passed:true, checks:['strict CSP','real ELK worker','ready handshake','canvas navigation','stale symbol rejection','import/call/route locations','follow active editor without feedback','selection and viewport preserved','fit','error retry','375px layout','empty workspace'], cspViolations:await evaluate('window.violations')}, null, 2));
  console.log('PASS: strict CSP, actual ELK worker, ready, canvas navigation, stale symbols, locations, follow/refresh, fit, error, narrow and empty states');
} finally {
  chrome.kill();
  await exited;
  await rm(profile, {recursive:true, force:true});
}
