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
 *  - 트리거(인라인 확장) 모델: render 시 버튼만 → 클릭 시 iframe 마운트
 *  - 생명주기 idle→expanded→verified→reset→idle, fail→idle (DOM 관측으로 검증)
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
function triggerOf(div) { return div.children.find((c) => c.tagName === 'BUTTON'); }
function verifiedOf(div) { return div.children.find((c) => c.getAttribute && c.getAttribute('class') === 'agami-verified'); }
// 트리거 클릭(네이티브 button.onclick) → iframe 마운트. 마운트된 iframe 반환.
function clickTrigger(div) { const b = triggerOf(div); b.onclick(); return iframeOf(div); }

// === 1) 전역/API ===
ok('window.agami 단일 전역 노출', agami && typeof agami === 'object');
ok('render/reset/getResponse 존재',
  typeof agami.render === 'function' && typeof agami.reset === 'function' && typeof agami.getResponse === 'function');

// === 2) implicit 자동 렌더 (트리거 모델: 렌더 시 버튼만, 클릭 시 iframe) ===
ok('implicit div 렌더됨(data-agami-rendered)', !!implicitDiv.getAttribute('data-agami-rendered'));
ok('implicit 초기엔 트리거 버튼 존재', !!triggerOf(implicitDiv));
ok('implicit 초기엔 iframe 없음(지연 생성)', !iframeOf(implicitDiv));
const impFrame = clickTrigger(implicitDiv); // 트리거 클릭 → iframe 마운트
ok('implicit 클릭 후 iframe 생성', !!impFrame);
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
const f1 = clickTrigger(box1); // 트리거 클릭 → iframe 마운트
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
const f2 = clickTrigger(box2); // 트리거 클릭 → iframe 마운트
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
const f3 = clickTrigger(box3); // 트리거 클릭 → iframe 마운트(+스피너 생성)
ok('초기 스피너 존재', !!box3.querySelector('[data-agami-loading]'));
f3.onload(); // iframe 로드 시뮬레이션
ok('onload 후 스피너 제거', !box3.querySelector('[data-agami-loading]'));

// === 9) resize 메시지(Stage 3) → height 적용 ===
messageHandler({ origin: SERVICE_ORIGIN, data: { type: 'agami-resize', height: 320 }, source: f3.contentWindow });
ok('agami-resize 로 iframe height 설정', f3.style.height === '320px');

// === 10) reset → idle 복귀 (트리거 모델: src 재로드 아님 → iframe 제거) ===
const boxRs = makeEl('div'); boxRs.setAttribute('id', 'boxRs'); documentMock.body.appendChild(boxRs);
const idRs = agami.render('#boxRs', { sitekey: 'ck_test', kind: 'flashlight' });
const fRs = clickTrigger(boxRs);
messageHandler({ origin: SERVICE_ORIGIN, data: { type: 'agami-result', success: true, captchaToken: 'RS', wid: idRs }, source: fRs.contentWindow });
ok('reset 전 토큰 수신(RS)', agami.getResponse(idRs) === 'RS');
ok('reset 전 iframe 존재', !!iframeOf(boxRs));
agami.reset(idRs);
ok('reset 후 토큰 빈 문자열', agami.getResponse(idRs) === '');
ok('reset 후 iframe 제거(재로드 아님)', !iframeOf(boxRs));
ok('reset 후 verified 제거', !verifiedOf(boxRs));
ok('reset 후 트리거 버튼 복원(보임)', triggerOf(boxRs).hidden === false);
ok('reset 후 hidden input 비움', boxRs.querySelector('input[name="agami-captcha-response"]').value === '');

// === 11) MutationObserver 동적 추가 ===
ok('MutationObserver 콜백 등록됨', typeof moCallback === 'function');
const dynDiv = makeEl('div');
dynDiv.setAttribute('class', 'agami-captcha');
dynDiv.setAttribute('data-sitekey', 'ck_test');
dynDiv.setAttribute('data-kind', 'flashlight');
documentMock.body.appendChild(dynDiv);
moCallback([{ addedNodes: [dynDiv] }]);
ok('동적 div 자동 렌더(트리거 버튼)', !!dynDiv.getAttribute('data-agami-rendered') && !!triggerOf(dynDiv));
ok('동적 div 초기 iframe 없음', !iframeOf(dynDiv));
ok('동적 div 클릭 후 iframe 생성', !!clickTrigger(dynDiv));

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

// === 15) 트리거 생명주기 (idle → expanded → verified → reset → idle → fail) ===
//   phase 는 내부 상태(API 미노출) → 관측 가능한 DOM(트리거 버튼/iframe/verified)으로 검증.
const boxT = makeEl('div'); boxT.setAttribute('id', 'boxT'); documentMock.body.appendChild(boxT);
let cbT = null, cbTErr = null;
const idT = agami.render('#boxT', { sitekey: 'ck_test', kind: 'flashlight', callback: (t) => { cbT = t; }, errorCallback: (e) => { cbTErr = e; } });
// (a) render 직후: 버튼 존재 / iframe 부재 / idle
ok('(a) render 직후 트리거 버튼 존재', !!triggerOf(boxT));
ok('(a) render 직후 iframe 부재(지연 생성)', !iframeOf(boxT));
ok('(a) render 직후 idle(버튼 보임)', triggerOf(boxT).hidden !== true);
ok('(a) render 직후 verified 없음', !verifiedOf(boxT));
ok('(a) 초기 토큰 빈 문자열', agami.getResponse(idT) === '');
// (b) 클릭 → expanded
const fT = clickTrigger(boxT);
ok('(b) 클릭 후 iframe 생성', !!fT);
ok('(b) expanded: 트리거 버튼 숨김', triggerOf(boxT).hidden === true);
ok('(b) expanded: iframe 보임(display!=none)', fT.style.display !== 'none');
ok('(b) expanded: verified 없음', !verifiedOf(boxT));
// (c) success → verified
messageHandler({ origin: SERVICE_ORIGIN, data: { type: 'agami-result', success: true, captchaToken: 'TOK_T', challengeId: 'cT', challengeType: 'flashlight', wid: idT }, source: fT.contentWindow });
ok('(c) verified: 토큰 보존', agami.getResponse(idT) === 'TOK_T');
ok('(c) verified: 성공 콜백 호출', cbT === 'TOK_T');
ok('(c) verified: iframe 접힘(display:none)', fT.style.display === 'none');
ok('(c) verified: verified 표시 존재', !!verifiedOf(boxT));
ok('(c) verified: 트리거 버튼 숨김 유지', triggerOf(boxT).hidden === true);
// (d) reset → idle
agami.reset(idT);
ok('(d) reset 후 토큰 빈 문자열', agami.getResponse(idT) === '');
ok('(d) reset 후 iframe 제거', !iframeOf(boxT));
ok('(d) reset 후 verified 제거', !verifiedOf(boxT));
ok('(d) reset 후 트리거 버튼 복원(보임)', triggerOf(boxT).hidden === false);
// (e) 재클릭 → expanded → fail → idle
const fT2 = clickTrigger(boxT);
ok('(e) 재클릭 후 새 iframe(보임)', !!fT2 && fT2.style.display !== 'none');
messageHandler({ origin: SERVICE_ORIGIN, data: { type: 'agami-result', success: false, wid: idT }, source: fT2.contentWindow });
ok('(e) fail 후 토큰 빈 문자열', agami.getResponse(idT) === '');
ok('(e) fail 후 errorCallback 호출', cbTErr && cbTErr.success === false);
ok('(e) fail 후 iframe 제거(idle)', !iframeOf(boxT));
ok('(e) fail 후 트리거 버튼 복원', triggerOf(boxT).hidden === false);
ok('(e) fail 후 verified 없음', !verifiedOf(boxT));

// === 16) reset 후 재마운트 라우팅(live-read) + 멀티위젯 격리 ===
const boxR = makeEl('div'); boxR.setAttribute('id', 'boxR'); documentMock.body.appendChild(boxR);
const idR = agami.render('#boxR', { sitekey: 'ck_test', kind: 'flashlight' });
const fR1 = clickTrigger(boxR);
const cwR1 = fR1.contentWindow;
messageHandler({ origin: SERVICE_ORIGIN, data: { type: 'agami-result', success: true, captchaToken: 'R1' }, source: cwR1 });
ok('재마운트 전 토큰 수신(R1)', agami.getResponse(idR) === 'R1');

// 별개 위젯 M (멀티위젯 격리 확인용)
const boxM = makeEl('div'); boxM.setAttribute('id', 'boxM'); documentMock.body.appendChild(boxM);
const idM = agami.render('#boxM', { sitekey: 'ck_test', kind: 'flashlight' });
const fM = clickTrigger(boxM);
const cwM = fM.contentWindow;
messageHandler({ origin: SERVICE_ORIGIN, data: { type: 'agami-result', success: true, captchaToken: 'M1' }, source: cwM });
ok('위젯M 토큰 수신(M1)', agami.getResponse(idM) === 'M1');

agami.reset(idR);
ok('reset 후 옛 iframe 제거', !iframeOf(boxR));
const fR2 = clickTrigger(boxR); // 재클릭 → 새 iframe(새 contentWindow)
const cwR2 = fR2.contentWindow;
ok('재마운트 iframe 은 새 contentWindow', cwR2 !== cwR1);
messageHandler({ origin: SERVICE_ORIGIN, data: { type: 'agami-result', success: true, captchaToken: 'R2' }, source: cwR2 });
ok('재마운트 후 새 contentWindow 로 라우팅(R2, live-read)', agami.getResponse(idR) === 'R2');
// 옛 contentWindow(제거된 iframe) 지연 메시지는 무시(현재 iframe 불일치 + wid 없음).
messageHandler({ origin: SERVICE_ORIGIN, data: { type: 'agami-result', success: true, captchaToken: 'R_STALE' }, source: cwR1 });
ok('옛 contentWindow 지연 메시지 무시', agami.getResponse(idR) === 'R2');
// 멀티위젯 격리: idR reset/재마운트가 idM 라우팅을 깨지 않음.
messageHandler({ origin: SERVICE_ORIGIN, data: { type: 'agami-result', success: true, captchaToken: 'M2' }, source: cwM });
ok('위젯M 계속 자기 contentWindow 로 라우팅(M2)', agami.getResponse(idM) === 'M2');

// === 17) embed base override hook (data-embed-base / window.AGAMI_EMBED_BASE) ===
// 각 시나리오를 독립 vm 컨텍스트에서 로더를 재실행해 검증(EMBED_BASE 는 로드 시 1회 확정).
//   loader 는 localhost(127.0.0.1:5500)에서 로드된 것으로 가정, script src 는 derived.example.
function loadCtx(opts) {
  opts = opts || {};
  const scriptEl = makeEl('script');
  scriptEl.src = opts.scriptSrc || 'https://derived.example/widget/loader.js';
  if (opts.dataEmbedBase != null) scriptEl.setAttribute('data-embed-base', opts.dataEmbedBase);
  let localMsg = null;
  const doc = {
    currentScript: scriptEl,
    readyState: 'complete',
    createElement: (t) => makeEl(t),
    getElementsByTagName: () => [],
    addEventListener: () => {},
    querySelector: () => null,
    querySelectorAll: () => [],
  };
  doc.documentElement = makeEl('html');
  doc.body = makeEl('body');
  const c = {
    console, URL, Date, Math, Number, Object, encodeURIComponent,
    setTimeout: () => 0, clearTimeout: () => {},
    document: doc,
    location: { href: 'http://127.0.0.1:5500/demo.html', origin: 'http://127.0.0.1:5500' },
    MutationObserver: function () { this.observe = () => {}; this.disconnect = () => {}; },
    addEventListener: (type, fn) => { if (type === 'message') localMsg = fn; },
  };
  if (opts.windowEmbedBase != null) c.AGAMI_EMBED_BASE = opts.windowEmbedBase;
  c.window = c; c.globalThis = c;
  vm.createContext(c);
  vm.runInContext(code, c);
  return {
    agami: c.agami,
    srcOf() {
      const div = makeEl('div');
      const id = c.agami.render(div, { sitekey: 'ck_test', kind: 'flashlight' });
      div.children.find((x) => x.tagName === 'BUTTON').onclick(); // 트리거 클릭 → iframe 마운트
      const f = div.children.find((x) => x.tagName === 'IFRAME');
      return { src: f.src, div, iframe: f, id };
    },
    send(ev) { if (localMsg) localMsg(ev); },
  };
}
const DERIVED = 'https://derived.example/widget/embed'; // override 없을 때의 유도 base

// (a) override 미설정 → 유도값 그대로(기본 동작 불변)
ok('(a) override 미설정 → 유도 base 그대로', loadCtx({}).srcOf().src.startsWith(DERIVED + '?'));

// (b) data-embed-base 설정 → 그 base 로 src + host 는 부모 origin 유지(별개)
{
  const { src } = loadCtx({ dataEmbedBase: 'https://agami-captcha.cloud/widget/embed' }).srcOf();
  ok('(b) data-embed-base → src 가 그 base 로 시작', src.startsWith('https://agami-captcha.cloud/widget/embed?'));
  ok('(b) host 는 여전히 부모 origin(별개 유지)', src.includes('host=' + encodeURIComponent('http://127.0.0.1:5500')));
}

// (c) window 전역만 설정 → 그 base 로 src
ok('(c) window.AGAMI_EMBED_BASE → 그 base 로 시작',
  loadCtx({ windowEmbedBase: 'https://win.example/widget/embed' }).srcOf().src.startsWith('https://win.example/widget/embed?'));

// (d) 둘 다 설정 → data-* 우선
ok('(d) data-* 가 window 보다 우선',
  loadCtx({ dataEmbedBase: 'https://data.example/widget/embed', windowEmbedBase: 'https://win.example/widget/embed' })
    .srcOf().src.startsWith('https://data.example/widget/embed?'));

// (e) 잘못된 값 → 무시하고 폴백(유도값)
ok('(e) 상대경로 override 무시 → 유도 폴백',
  loadCtx({ dataEmbedBase: '/widget/embed' }).srcOf().src.startsWith(DERIVED + '?'));
ok("(e') 빈 값 override 무시 → 유도 폴백",
  loadCtx({ dataEmbedBase: '', windowEmbedBase: '' }).srcOf().src.startsWith(DERIVED + '?'));
ok("(e'') 비-http(file:) override 무시 → 유도 폴백",
  loadCtx({ dataEmbedBase: 'file:///etc/passwd' }).srcOf().src.startsWith(DERIVED + '?'));

// (f) override 시 SERVICE_ORIGIN 도 그 origin → 그 origin 메시지만 게이트 통과
{
  const env = loadCtx({ dataEmbedBase: 'https://agami-captcha.cloud/widget/embed' });
  const { id, iframe } = env.srcOf();
  env.send({ origin: 'https://agami-captcha.cloud', data: { type: 'agami-result', success: true, captchaToken: 'OVT', wid: id }, source: iframe.contentWindow });
  ok('(f) override origin 결과는 게이트 통과(토큰 반영)', env.agami.getResponse(id) === 'OVT');
  env.send({ origin: 'http://127.0.0.1:5500', data: { type: 'agami-result', success: true, captchaToken: 'BAD', wid: id }, source: iframe.contentWindow });
  ok('(f) 비-override(부모 localhost) origin 메시지는 거부', env.agami.getResponse(id) === 'OVT');
}

console.log('\nALL PASSED — ' + pass + ' assertions');
