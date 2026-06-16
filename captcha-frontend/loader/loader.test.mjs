/**
 * loader.js 단위 검증 (브라우저 없이 Node vm + 최소 DOM 목으로 실행)
 * 실행: node loader/loader.test.mjs   (먼저 npm run build:loader 로 dist/loader.js 생성)
 *
 * 검증 항목:
 *  - iframe src 형식(kind/client_key/wid/host, difficulty 없음, EMBED_BASE)
 *  - sandbox / allow(camera) 속성
 *  - postMessage origin 검증(잘못된 origin 무시)
 *  - source(iframe.contentWindow) 기반 위젯 라우팅 + 멀티위젯 격리
 *  - 성공/실패 콜백, hidden input, getResponse/reset
 *  - ready 미수신 대비(onload 시 스피너 제거)
 *  - implicit 스캔 + MutationObserver 동적 추가
 *  - wid forward-compat 라우팅
 */
import vm from 'node:vm';
import fs from 'node:fs';
import assert from 'node:assert';

const code = fs.readFileSync(new URL('../dist/loader.js', import.meta.url), 'utf8');

// --- 최소 DOM 목 ----------------------------------------------------------
const ALL = [];
let frameSeq = 0;

function matches(el, sel) {
  if (sel === '[data-agami-loading]') return el.hasAttribute('data-agami-loading');
  if (sel === 'input[name="agami-captcha-response"]')
    // 실제 DOM 은 input.name 프로퍼티를 [name] 속성으로 반영함 → 양쪽 모두 허용.
    return el.tagName === 'INPUT' &&
      (el.name === 'agami-captcha-response' || el.getAttribute('name') === 'agami-captcha-response');
  if (sel === '.agami-captcha:not([data-agami-rendered])')
    return el.classList.contains('agami-captcha') && !el.hasAttribute('data-agami-rendered');
  if (sel[0] === '#') return el.getAttribute('id') === sel.slice(1);
  return false;
}
function descendants(el, out) {
  out = out || [];
  for (const c of el.children) { out.push(c); descendants(c, out); }
  return out;
}
function makeEl(tag) {
  const el = {
    nodeType: 1,
    tagName: (tag || 'div').toUpperCase(),
    _attrs: {},
    style: { cssText: '', height: '' },
    children: [],
    parentNode: null,
    onload: null,
    value: '',
    classList: {
      _s: new Set(),
      add(c) { this._s.add(c); },
      contains(c) { return this._s.has(c); },
    },
    setAttribute(k, v) {
      this._attrs[k] = String(v);
      if (k === 'class') String(v).split(/\s+/).forEach((c) => this.classList.add(c));
    },
    getAttribute(k) { return Object.prototype.hasOwnProperty.call(this._attrs, k) ? this._attrs[k] : null; },
    hasAttribute(k) { return Object.prototype.hasOwnProperty.call(this._attrs, k); },
    removeAttribute(k) { delete this._attrs[k]; },
    appendChild(c) { c.parentNode = el; el.children.push(c); ALL.push(c); return c; },
    insertBefore(c, ref) {
      c.parentNode = el;
      const i = el.children.indexOf(ref);
      if (i < 0) el.children.push(c); else el.children.splice(i, 0, c);
      ALL.push(c); return c;
    },
    removeChild(c) { const i = el.children.indexOf(c); if (i >= 0) el.children.splice(i, 1); c.parentNode = null; return c; },
    querySelector(sel) { return descendants(el).find((d) => matches(d, sel)) || null; },
    querySelectorAll(sel) { return descendants(el).filter((d) => matches(d, sel)); },
  };
  if (el.tagName === 'IFRAME') {
    frameSeq += 1;
    el.contentWindow = { __frame: frameSeq };
    Object.defineProperty(el, 'src', {
      get() { return el._attrs.src || ''; },
      set(v) { el._attrs.src = String(v); },
      configurable: true,
    });
  }
  return el;
}

let messageHandler = null;
let moCallback = null;

const documentMock = {
  currentScript: { src: 'https://agami-captcha.cloud/widget/loader.js' },
  readyState: 'complete',
  createElement: (t) => makeEl(t),
  getElementsByTagName: () => [],
  addEventListener: () => {},
  querySelector: (sel) => ALL.find((el) => matches(el, sel)) || null,
  querySelectorAll: (sel) => ALL.filter((el) => matches(el, sel)),
};
documentMock.documentElement = makeEl('html');
documentMock.body = makeEl('body');

// implicit 대상 div 1개를 로드 전에 미리 배치 (startAuto 스캔이 잡아야 함)
const implicitDiv = makeEl('div');
implicitDiv.setAttribute('class', 'agami-captcha');
implicitDiv.setAttribute('data-sitekey', 'ck_test');
implicitDiv.setAttribute('data-kind', 'context_inference');
documentMock.body.appendChild(implicitDiv);

const ctx = {
  console,
  URL,
  Date,
  Math,
  Number,
  Object,
  encodeURIComponent,
  setTimeout: () => 0, // ready 타임아웃은 실제 스케줄하지 않음(결정적 테스트)
  clearTimeout: () => {},
  document: documentMock,
  location: { href: 'https://member.example/page', origin: 'https://member.example' },
  MutationObserver: function (cb) { moCallback = cb; this.observe = () => {}; this.disconnect = () => {}; },
  addEventListener: (type, fn) => { if (type === 'message') messageHandler = fn; },
};
ctx.window = ctx;
ctx.globalThis = ctx;

vm.createContext(ctx);
vm.runInContext(code, ctx);

const agami = ctx.agami;
const SERVICE_ORIGIN = 'https://agami-captcha.cloud';

// --- 단언 헬퍼 ------------------------------------------------------------
let pass = 0;
function ok(name, cond) {
  if (cond) { pass += 1; console.log('  ✓ ' + name); }
  else { console.error('  ✗ ' + name); throw new Error('FAILED: ' + name); }
}
function iframeOf(div) { return div.children.find((c) => c.tagName === 'IFRAME'); }

// === 1) 전역/API ===
ok('window.agami 단일 전역 노출', agami && typeof agami === 'object');
ok('render/reset/getResponse 존재',
  typeof agami.render === 'function' && typeof agami.reset === 'function' && typeof agami.getResponse === 'function');

// === 2) implicit 자동 렌더 ===
ok('implicit div 렌더됨(data-agami-rendered)', !!implicitDiv.getAttribute('data-agami-rendered'));
const impFrame = iframeOf(implicitDiv);
ok('implicit iframe 생성', !!impFrame);
ok('implicit src kind=context_inference', impFrame.src.includes('kind=context_inference'));
ok('implicit src client_key=ck_test', impFrame.src.includes('client_key=ck_test'));
ok('implicit src wid 포함', /[?&]wid=agami-/.test(impFrame.src));
ok('implicit src host=member origin', impFrame.src.includes('host=' + encodeURIComponent('https://member.example')));
ok('src 가 EMBED_BASE 로 시작', impFrame.src.startsWith('https://agami-captcha.cloud/widget/embed?'));
ok('★ difficulty 파라미터 없음', impFrame.src.indexOf('difficulty') === -1);

// === 3) explicit 렌더 + sandbox/allow ===
const box1 = makeEl('div'); box1.setAttribute('id', 'box1'); documentMock.body.appendChild(box1);
let cb1Token = null, cb1Err = null;
const id1 = agami.render('#box1', {
  sitekey: 'ck_test', kind: 'flashlight',
  callback: (t) => { cb1Token = t; },
  errorCallback: (e) => { cb1Err = e; },
});
ok('explicit render → widgetId 반환(string)', typeof id1 === 'string' && id1.startsWith('agami-'));
const f1 = iframeOf(box1);
ok('explicit iframe src kind=flashlight', f1.src.includes('kind=flashlight'));
ok('sandbox=allow-scripts allow-same-origin', f1.getAttribute('sandbox') === 'allow-scripts allow-same-origin');
ok('allow 에 camera 포함(face_mission)', (f1.getAttribute('allow') || '').includes('camera'));
ok('explicit 초기 토큰 빈 문자열', agami.getResponse(id1) === '');

// === 4) origin 검증: 잘못된 origin 무시 ===
messageHandler({ origin: 'https://evil.example', data: { type: 'agami-result', success: true, captchaToken: 'BAD' }, source: f1.contentWindow });
ok('잘못된 origin 메시지 무시(토큰 미설정)', agami.getResponse(id1) === '' && cb1Token === null);

// === 5) 올바른 origin + source 매칭 → 성공 처리 ===
messageHandler({ origin: SERVICE_ORIGIN, data: { type: 'agami-result', success: true, captchaToken: 'TOK_OK', challengeId: 'c1', challengeType: 'flashlight' }, source: f1.contentWindow });
ok('성공 시 getResponse=TOK_OK', agami.getResponse(id1) === 'TOK_OK');
ok('성공 시 hidden input 값 주입', box1.querySelector('input[name="agami-captcha-response"]').value === 'TOK_OK');
ok('성공 콜백 호출(token 전달)', cb1Token === 'TOK_OK');

// === 6) 멀티위젯 격리 ===
const box2 = makeEl('div'); box2.setAttribute('id', 'box2'); documentMock.body.appendChild(box2);
let cb2Token = null;
const id2 = agami.render('#box2', { sitekey: 'ck_test', kind: 'flashlight', callback: (t) => { cb2Token = t; } });
const f2 = iframeOf(box2);
ok('두 위젯 widgetId 상이', id1 !== id2);
messageHandler({ origin: SERVICE_ORIGIN, data: { type: 'agami-result', success: true, captchaToken: 'TOK2' }, source: f2.contentWindow });
ok('위젯2 토큰만 갱신', agami.getResponse(id2) === 'TOK2');
ok('위젯1 토큰 불변(격리)', agami.getResponse(id1) === 'TOK_OK');
ok('위젯2 콜백만 호출', cb2Token === 'TOK2' && cb1Token === 'TOK_OK');

// === 7) 실패 처리 ===
messageHandler({ origin: SERVICE_ORIGIN, data: { type: 'agami-result', success: false }, source: f1.contentWindow });
ok('실패 시 토큰 비움', agami.getResponse(id1) === '');
ok('실패 시 hidden input 비움', box1.querySelector('input[name="agami-captcha-response"]').value === '');
ok('실패 콜백(errorCallback) 호출', cb1Err && cb1Err.success === false);

// === 8) ready 미수신 대비: onload 시 스피너 제거 ===
const box3 = makeEl('div'); box3.setAttribute('id', 'box3'); documentMock.body.appendChild(box3);
const id3 = agami.render('#box3', { sitekey: 'ck_test', kind: 'flashlight' });
const f3 = iframeOf(box3);
ok('초기 스피너 존재', !!box3.querySelector('[data-agami-loading]'));
f3.onload(); // iframe 로드 시뮬레이션
ok('onload 후 스피너 제거', !box3.querySelector('[data-agami-loading]'));

// === 9) resize 메시지(Stage 3) → height 적용 ===
messageHandler({ origin: SERVICE_ORIGIN, data: { type: 'agami-resize', height: 320 }, source: f3.contentWindow });
ok('agami-resize 로 iframe height 설정', f3.style.height === '320px');

// === 10) reset ===
const srcBefore = f1.src;
agami.reset(id1);
ok('reset 후 토큰 빈 문자열', agami.getResponse(id1) === '');
ok('reset 시 iframe src 재로드(cache-buster)', f1.src !== srcBefore && f1.src.includes('&_='));

// === 11) MutationObserver 동적 추가 ===
ok('MutationObserver 콜백 등록됨', typeof moCallback === 'function');
const dynDiv = makeEl('div');
dynDiv.setAttribute('class', 'agami-captcha');
dynDiv.setAttribute('data-sitekey', 'ck_test');
dynDiv.setAttribute('data-kind', 'flashlight');
documentMock.body.appendChild(dynDiv);
moCallback([{ addedNodes: [dynDiv] }]);
ok('동적 div 자동 렌더', !!dynDiv.getAttribute('data-agami-rendered') && !!iframeOf(dynDiv));

// === 12) wid forward-compat 라우팅 ===
// source 가 일치하지 않아도 data.wid 가 레지스트리에 있으면 그 위젯으로 라우팅.
let cbWidToken = agami.getResponse(id2);
messageHandler({ origin: SERVICE_ORIGIN, data: { type: 'agami-result', success: true, captchaToken: 'VIA_WID', wid: id2 }, source: { __frame: 'unrelated' } });
ok('data.wid 우선 라우팅(Stage 3 호환)', agami.getResponse(id2) === 'VIA_WID');

// === 13) 견고성: 알 수 없는 source + wid 없음 → 무시(크래시 X) ===
messageHandler({ origin: SERVICE_ORIGIN, data: { type: 'agami-result', success: true, captchaToken: 'X' }, source: { __frame: 'nobody' } });
ok('미등록 source 메시지 안전 무시', true);

// === 14) render 견고성: 없는 선택자 → throw 안 함 ===
let threw = false;
try { const r = agami.render('#does-not-exist', {}); ok('없는 선택자 → undefined 반환', r === undefined); } catch (e) { threw = true; }
ok('없는 선택자에도 throw 하지 않음', threw === false);

// === 15) reset 후 source 매칭 (핵심: live-read 라우팅) ===
// findWidget 은 w.iframe.contentWindow 를 매번 라이브로 읽으므로, reset 으로 iframe 이
// 재로드돼 contentWindow 가 바뀌어도(또는 실브라우저처럼 동일 유지돼도) 항상 최신값과 비교된다.
const box4 = makeEl('div'); box4.setAttribute('id', 'box4'); documentMock.body.appendChild(box4);
let cb4 = null;
const id4 = agami.render('#box4', { sitekey: 'ck_test', kind: 'flashlight', callback: (t) => { cb4 = t; } });
const f4 = iframeOf(box4);
const oldCW4 = f4.contentWindow;
messageHandler({ origin: SERVICE_ORIGIN, data: { type: 'agami-result', success: true, captchaToken: 'T_OLD' }, source: oldCW4 });
ok('reset 전 토큰 수신(T_OLD)', agami.getResponse(id4) === 'T_OLD' && cb4 === 'T_OLD');

agami.reset(id4);
ok('reset 후 토큰 비움', agami.getResponse(id4) === '');
ok('reset 시 src cache-buster(&_=)', f4.src.includes('&_='));
ok('reset 후 w.iframe 동일 엘리먼트 유지(요소 교체 아님)', iframeOf(box4) === f4);

// (A) 실브라우저: 같은 iframe 재로드 시 WindowProxy(contentWindow) 동일 유지 → 같은 CW 로도 라우팅.
messageHandler({ origin: SERVICE_ORIGIN, data: { type: 'agami-result', success: true, captchaToken: 'T_SAME' }, source: oldCW4 });
ok('reset 후 동일 contentWindow(실브라우저 동작)로 라우팅', agami.getResponse(id4) === 'T_SAME');

// (B) 보수적 최악 가정: 재로드로 새 contentWindow 가 생긴 경우 → live-read 가 최신값을 본다.
const newCW4 = { __frame: 'reloaded-4' };
f4.contentWindow = newCW4; // 브라우저가 새 WindowProxy 를 줬다고 가정
messageHandler({ origin: SERVICE_ORIGIN, data: { type: 'agami-result', success: true, captchaToken: 'T_NEW' }, source: newCW4 });
ok('★ reset 후 새 contentWindow 결과가 해당 위젯에 라우팅(live-read)', agami.getResponse(id4) === 'T_NEW');

// (B') 옛 contentWindow 에서 온 지연 메시지는 무시.
messageHandler({ origin: SERVICE_ORIGIN, data: { type: 'agami-result', success: true, captchaToken: 'T_STALE' }, source: oldCW4 });
ok('reset 후 옛 contentWindow(지연) 메시지 무시', agami.getResponse(id4) === 'T_NEW');

// === 16) 멀티위젯: 한쪽만 reset 해도 다른 쪽 라우팅 유지 ===
const box5 = makeEl('div'); box5.setAttribute('id', 'box5'); documentMock.body.appendChild(box5);
const id5 = agami.render('#box5', { sitekey: 'ck_test', kind: 'flashlight' });
const f5 = iframeOf(box5);
const cw5 = f5.contentWindow;
messageHandler({ origin: SERVICE_ORIGIN, data: { type: 'agami-result', success: true, captchaToken: 'W5' }, source: cw5 });
ok('위젯5 토큰 수신(W5)', agami.getResponse(id5) === 'W5');

agami.reset(id4);
const newCW4b = { __frame: 'reloaded-4b' };
f4.contentWindow = newCW4b;
messageHandler({ origin: SERVICE_ORIGIN, data: { type: 'agami-result', success: true, captchaToken: 'T_NEW2' }, source: newCW4b });
ok('위젯4 재reset 후 라우팅 정상(T_NEW2)', agami.getResponse(id4) === 'T_NEW2');
ok('위젯4 reset 이 위젯5 라우팅 깨지 않음', agami.getResponse(id5) === 'W5');
messageHandler({ origin: SERVICE_ORIGIN, data: { type: 'agami-result', success: true, captchaToken: 'W5b' }, source: cw5 });
ok('위젯5 계속 자기 contentWindow 로 라우팅(W5b)', agami.getResponse(id5) === 'W5b');

console.log('\nALL PASSED — ' + pass + ' assertions');
