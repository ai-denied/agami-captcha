/**
 * Agami CAPTCHA Loader (Stage 2)
 * ==============================
 * "script 태그 + 내부 iframe" 임베드용 얇은 래퍼.
 * 회원사는 script 한 줄 + div 한 줄만 넣으면 캡차가 뜬다.
 *
 * - 바닐라 JS만 사용. React/프레임워크/외부 라이브러리 의존성 0.
 * - 전역은 window.agami 하나만 노출 (reCAPTCHA/hCaptcha/Turnstile 호환 API).
 * - iframe 내부 위젯(EmbedEntry)은 이미 완성돼 있으므로 그대로 재사용한다.
 *   새 캡차 로직은 만들지 않는다.
 *
 * 트리거(인라인 확장) 모델 — 위젯 단위 상태머신(widgets[wid].phase):
 *   idle(트리거 버튼만) → [클릭] → expanded(iframe+챌린지)
 *     → [agami-result success] → verified(iframe 접힘 + ✓)
 *     → [agami-result fail]    → idle(iframe 제거, 버튼 복원)
 *   reset() → idle(iframe 제거, 버튼 복원). 재도전은 트리거 버튼 재클릭.
 *   ※ iframe(=챌린지 발급)은 트리거 클릭 시점에만 생성한다(렌더 즉시 아님).
 *
 * iframe → loader 메시지(EmbedEntry 발신):
 *   { type:'agami-result', success, challengeId, challengeType, captchaToken, wid }
 *   - wid 에코가 실제로 오므로(EmbedEntry + parentMessaging 라이브) data.wid 를
 *     우선 라우팅하고, 없으면 event.source(iframe.contentWindow) 매칭으로 폴백한다.
 *   - 'agami-ready'(첫 표시 완료) / 'agami-resize'(높이 통지) 도 라이브로 수신한다.
 *     안 와도 깨지지 않도록 onload + 타임아웃으로 로딩 표시를 제거한다.
 */

// ---------------------------------------------------------------------------
// 0. 서비스 origin / embed base 결정.
//    우선순위(높은 것부터):
//      (1) <script ... data-embed-base="https://.../widget/embed">
//      (2) window.AGAMI_EMBED_BASE
//      (3) loader 자신이 로드된 origin 에서 유도 (기본/폴백 — 기존과 동일)
//    ※ override 미설정 시 (3) 으로 가며 동작은 기존과 1바이트도 다르지 않다
//       (프로덕션 회원은 hook 을 안 쓰므로 무영향 — 최우선 안전 제약).
//    ※ override 값은 "절대 http(s) URL(embed base 전체)" 만 허용. 상대경로/빈값/
//       비-http 는 무시하고 폴백. (검증용/환경분리: 로컬 loader + 원격 embed.)
//    ※ override 의 origin 은 SERVICE_ORIGIN(postMessage 게이트)도 된다 — iframe 이
//       그 origin 에서 로드되므로 결과/ready/resize 메시지가 그 origin 으로 온다.
//       이걸 안 맞추면 게이트(아래 onMessage)에서 전부 막혀 검증이 무의미해진다.
//       (원본도 EMBED_BASE 와 SERVICE_ORIGIN 을 동일 출처에서 함께 유도했다.)
// ---------------------------------------------------------------------------
function currentScriptEl() {
  if (document.currentScript && document.currentScript.src) {
    return document.currentScript;
  }
  // currentScript 를 못 잡는 경우(비동기 주입 등): src 에 loader.js 가 든 마지막 script.
  var scripts = document.getElementsByTagName('script');
  for (var i = scripts.length - 1; i >= 0; i--) {
    if (scripts[i].src && scripts[i].src.indexOf('loader.js') !== -1) {
      return scripts[i];
    }
  }
  return null;
}

// override 후보 1개를 "절대 http(s) URL" 로 검증 → { base, origin } 또는 null.
//   - new URL(raw) 에 base 를 주지 않으므로 상대경로/빈값이면 throw → null(폴백).
//   - http/https 만 허용(file:/javascript: 등 차단). 끝의 '/' 는 정규화로 제거.
function normalizeEmbedBase(raw) {
  if (typeof raw !== 'string' || !raw) return null;
  try {
    var ou = new URL(raw);
    if (ou.protocol !== 'http:' && ou.protocol !== 'https:') return null;
    if (!ou.origin || ou.origin === 'null') return null;
    return { base: ou.href.replace(/\/+$/, ''), origin: ou.origin };
  } catch {
    return null;
  }
}

// 우선순위: data-embed-base(스크립트 태그) > window.AGAMI_EMBED_BASE.
function readEmbedBaseOverride() {
  var fromAttr = (SCRIPT_EL && SCRIPT_EL.getAttribute) ? SCRIPT_EL.getAttribute('data-embed-base') : null;
  var picked = normalizeEmbedBase(fromAttr);
  if (picked) return picked;
  var fromGlobal = (typeof window !== 'undefined') ? window.AGAMI_EMBED_BASE : null;
  return normalizeEmbedBase(fromGlobal);
}

var SCRIPT_EL = currentScriptEl();
var SCRIPT_SRC = (SCRIPT_EL && SCRIPT_EL.src) || '';
var SERVICE_ORIGIN = ''; // postMessage origin 검증 기준
var EMBED_BASE = ''; // iframe src 의 베이스 ('.../widget/embed')

var EMBED_OVERRIDE = readEmbedBaseOverride();
if (EMBED_OVERRIDE) {
  // override: embed base 와 서비스 origin 을 함께 고정(둘 다 같은 출처여야 메시지 통과).
  EMBED_BASE = EMBED_OVERRIDE.base;
  SERVICE_ORIGIN = EMBED_OVERRIDE.origin;
} else {
  // 기본/폴백: loader 자신의 src origin 에서 유도(기존과 동일 — 무override 시 무변경).
  try {
    var u = new URL(SCRIPT_SRC, (typeof location !== 'undefined' ? location.href : undefined));
    SERVICE_ORIGIN = u.origin;
    // loader.js 와 embed 는 같은 디렉토리(/widget/) 의 형제 → loader.js 를 embed 로 치환.
    EMBED_BASE = u.href.slice(0, u.href.lastIndexOf('/')) + '/embed';
  } catch (e) {
    // 유도 실패: render 시 경고. (그래도 페이지를 죽이지 않는다.)
  }
}

// ---------------------------------------------------------------------------
// 1. 내부 상태
// ---------------------------------------------------------------------------
var widgets = {}; // widgetId -> { id, div, iframe, kind, sitekey, token, callback, errorCallback, readyTimer, phase, triggerBtn, statusEl, verifiedEl }
var seq = 0;

function warn(msg) {
  try { console.warn('[agami] ' + msg); } catch (e) { /* no-op */ }
}

function genId() {
  seq += 1;
  return 'agami-' + Date.now().toString(36) + '-' + seq + '-' + Math.random().toString(36).slice(2, 7);
}

function resolveEl(el) {
  if (typeof el === 'string') return document.querySelector(el);
  if (el && el.nodeType === 1) return el;
  return null;
}

// 콜백은 함수 또는 전역 함수 이름(data-callback="onSubmit") 둘 다 허용.
function resolveCb(cb) {
  if (typeof cb === 'function') return cb;
  if (typeof cb === 'string' && cb && typeof window[cb] === 'function') return window[cb];
  return null;
}

function buildSrc(kind, sitekey, wid) {
  var parts = [];
  parts.push('kind=' + encodeURIComponent(kind || 'flashlight'));
  if (sitekey) parts.push('client_key=' + encodeURIComponent(sitekey));
  parts.push('wid=' + encodeURIComponent(wid));
  parts.push('host=' + encodeURIComponent(location.origin));
  // difficulty 는 절대 넣지 않는다 (백엔드에서 제거됨 — Stage 0 완료).
  return EMBED_BASE + '?' + parts.join('&');
}

// ---------------------------------------------------------------------------
// 2. 로딩 표시 / hidden input
// ---------------------------------------------------------------------------
function makeSpinner() {
  var s = document.createElement('div');
  s.setAttribute('data-agami-loading', '1');
  s.style.cssText =
    'display:flex;align-items:center;justify-content:center;min-height:90px;' +
    'font:13px/1.4 system-ui,-apple-system,sans-serif;color:#6b7891;';
  s.textContent = '캡차 로딩 중…';
  return s;
}

function clearSpinner(w) {
  if (w.readyTimer) { clearTimeout(w.readyTimer); w.readyTimer = null; }
  var s = w.div.querySelector('[data-agami-loading]');
  if (s && s.parentNode) s.parentNode.removeChild(s);
}

function setHidden(w, value) {
  var input = w.div.querySelector('input[name="agami-captcha-response"]');
  if (!input) {
    input = document.createElement('input');
    input.type = 'hidden';
    input.name = 'agami-captcha-response';
    w.div.appendChild(input);
  }
  input.value = value || '';
}

// ---------------------------------------------------------------------------
// 3. 트리거/상태 UI 헬퍼 (idle ↔ expanded ↔ verified)
// ---------------------------------------------------------------------------
function removeEl(el) {
  // .remove() 대신 parentNode.removeChild — 구형/목 호환(기존 clearSpinner 와 동일 관례).
  if (el && el.parentNode) el.parentNode.removeChild(el);
}

// 트리거 버튼: 네이티브 <button> → Enter/Space 키보드 활성화 자동(WAI-ARIA button 패턴).
function makeTrigger(onClick) {
  var b = document.createElement('button');
  b.setAttribute('type', 'button'); // 폼 자동제출 방지
  b.setAttribute('class', 'agami-trigger');
  b.textContent = '사람인지 확인'; // 접근명(accessible name) = 버튼 텍스트
  b.style.cssText =
    'display:flex;align-items:center;gap:10px;width:100%;min-height:60px;box-sizing:border-box;' +
    'padding:0 16px;border:1px solid #e0e7f3;border-radius:12px;background:#fff;' +
    'font:14px/1.4 system-ui,-apple-system,sans-serif;color:#1d2a44;cursor:pointer;';
  b.onclick = onClick; // .onclick 프로퍼티(기존 iframe.onload 와 동일 관례)
  return b;
}

// 상태 안내 영역: aria-live="polite" + 시각상 sr-only(스크린리더 전용 안내).
function makeStatus() {
  var s = document.createElement('div');
  s.setAttribute('class', 'agami-status');
  s.setAttribute('aria-live', 'polite');
  s.style.cssText =
    'position:absolute;width:1px;height:1px;padding:0;margin:-1px;' +
    'overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0;';
  return s;
}
function setStatus(w, msg) {
  if (w.statusEl) w.statusEl.textContent = msg;
}

// verified 표시(컴팩트): 시각 ✓ + 텍스트 병기.
function makeVerified() {
  var v = document.createElement('div');
  v.setAttribute('class', 'agami-verified');
  v.textContent = '✓ 확인됨';
  v.style.cssText =
    'display:flex;align-items:center;gap:8px;min-height:60px;box-sizing:border-box;' +
    'padding:0 16px;border:1px solid #b7f0c8;border-radius:12px;background:#f0fff5;' +
    'font:14px/1.4 system-ui,-apple-system,sans-serif;color:#1a7f4b;';
  return v;
}
function showVerified(w) {
  if (!w.verifiedEl) {
    w.verifiedEl = makeVerified();
    w.div.appendChild(w.verifiedEl);
  } else {
    w.verifiedEl.hidden = false;
  }
}
function removeVerified(w) {
  if (w.verifiedEl) { removeEl(w.verifiedEl); w.verifiedEl = null; }
}

// iframe 제거(+스피너/타이머 정리). idle 복귀 시 사용.
function removeIframe(w) {
  if (w.iframe) {
    clearSpinner(w); // readyTimer 해제 + 로딩 표시 제거
    removeEl(w.iframe);
    w.iframe = null;
  }
}

// ---------------------------------------------------------------------------
// 4. 코어 렌더 (트리거 버튼만 부착; iframe 은 클릭 시 mountIframe 로 생성)
// ---------------------------------------------------------------------------
function renderInto(div, opts) {
  opts = opts || {};
  if (!EMBED_BASE) warn('loader origin 을 유도하지 못했습니다. iframe src 가 비정상일 수 있습니다.');

  var id = genId();
  var kind = opts.kind || 'flashlight';
  var sitekey = opts.sitekey || '';
  if (!sitekey) warn('sitekey(data-sitekey) 가 없습니다. 백엔드 기본 키로 폴백될 수 있습니다.');

  var w = {
    id: id,
    div: div,
    iframe: null, // ★ 트리거 클릭 전까지 생성하지 않음(챌린지 발급 지연)
    kind: kind,
    sitekey: sitekey,
    token: '',
    callback: resolveCb(opts.callback),
    errorCallback: resolveCb(opts.errorCallback),
    readyTimer: null,
    phase: 'idle', // idle → expanded → verified (위젯 단위 상태머신)
    triggerBtn: null,
    statusEl: null,
    verifiedEl: null,
  };
  widgets[id] = w;
  div.setAttribute('data-agami-rendered', id); // 중복 렌더 방지 표식

  // 상태 안내(aria-live, sr-only) 먼저 부착.
  w.statusEl = makeStatus();
  div.appendChild(w.statusEl);

  // 트리거 버튼 부착(idle). 클릭 → iframe 마운트 → expanded.
  w.triggerBtn = makeTrigger(function () {
    if (w.phase !== 'idle') return; // 중복 클릭/비정상 전이 방지
    mountIframe(w);
    w.triggerBtn.hidden = true;
    w.phase = 'expanded';
    setStatus(w, '확인을 시작합니다');
  });
  div.appendChild(w.triggerBtn);

  return id;
}

// iframe(=EmbedEntry/챌린지) 생성·삽입. 트리거 클릭 또는 명시 호출 시점에만 실행.
function mountIframe(w) {
  var iframe = document.createElement('iframe');
  iframe.src = buildSrc(w.kind, w.sitekey, w.id);
  iframe.title = 'Agami CAPTCHA';
  iframe.setAttribute('frameborder', '0');
  iframe.setAttribute('scrolling', 'no');
  iframe.style.cssText = 'width:100%;height:90px;border:0;display:block;';
  // 최소 권한 sandbox:
  //   allow-scripts      : 위젯(React)이 동작하려면 필수.
  //   allow-same-origin  : 위젯이 자기 origin(agami) 으로 백엔드 API 를 호출하고,
  //                        face_mission 카메라(getUserMedia)가 동작하며,
  //                        postMessage 의 event.origin 이 실제 서비스 origin 으로
  //                        오게 하려면 필수. (없으면 opaque/null origin → 검증 불가)
  //   top-navigation/popups/forms 등은 부여하지 않음(불필요·보안).
  //   ※ iframe 은 회원 페이지와 cross-origin 이므로 allow-same-origin 이 있어도
  //     회원 페이지에 접근하거나 sandbox 를 스스로 해제할 수 없다.
  iframe.setAttribute('sandbox', 'allow-scripts allow-same-origin');
  // 카메라 권한 위임(Permissions Policy). face_mission 의 MediaPipe getUserMedia 용.
  //   - sandbox 가 아니라 allow 속성이 카메라를 관장한다.
  //   - "camera" 는 iframe src origin(agami) 에 위임. 운영은 HTTPS 필수(보안 컨텍스트).
  iframe.setAttribute('allow', 'camera');

  var spinner = makeSpinner();
  w.div.appendChild(spinner);
  w.div.appendChild(iframe);
  w.iframe = iframe;

  // ready 미수신 대비: iframe onload 또는 8초 타임아웃 후 로딩 표시 제거.
  iframe.onload = function () { clearSpinner(w); };
  w.readyTimer = setTimeout(function () { clearSpinner(w); }, 8000);

  return iframe;
}

// ---------------------------------------------------------------------------
// 5. postMessage 수신 (window 단일 리스너 — 위젯별 분기)
// ---------------------------------------------------------------------------
function findWidget(data, source) {
  // data.wid 가 레지스트리에 있으면 우선(EmbedEntry 가 wid 를 에코 — 라이브).
  if (data && data.wid && widgets[data.wid]) return widgets[data.wid];
  // 폴백: source(iframe.contentWindow) 매칭(라이브 read — reset/재마운트로 바뀌어도 최신값 비교).
  for (var k in widgets) {
    if (Object.prototype.hasOwnProperty.call(widgets, k)) {
      if (widgets[k].iframe && widgets[k].iframe.contentWindow === source) return widgets[k];
    }
  }
  return null;
}

function onMessage(event) {
  // origin 검증: 우리 서비스 origin 과 정확히 일치하지 않으면 즉시 무시.
  if (!SERVICE_ORIGIN || event.origin !== SERVICE_ORIGIN) return;
  var data = event.data;
  if (!data || typeof data !== 'object') return;

  var w = findWidget(data, event.source);
  if (!w) return; // 어느 위젯 것도 아니면 무시 (멀티 위젯 혼선 방지)

  switch (data.type) {
    case 'agami-result':
      if (data.success) {
        w.token = data.captchaToken || '';
        setHidden(w, w.token);
        if (w.callback) {
          try { w.callback(w.token); } catch (e) { warn('callback 예외: ' + e); }
        }
        // 트리거: 성공 → verified(접힘 + ✓). 토큰은 이미 widgets[wid].token 에 있음.
        if (w.iframe) { clearSpinner(w); w.iframe.style.display = 'none'; }
        if (w.triggerBtn) w.triggerBtn.hidden = true;
        showVerified(w);
        w.phase = 'verified';
        setStatus(w, '확인되었습니다');
      } else {
        w.token = '';
        setHidden(w, '');
        if (w.errorCallback) {
          try { w.errorCallback(data); } catch (e) { warn('errorCallback 예외: ' + e); }
        }
        // 트리거: 실패 → idle(iframe 제거, 트리거 버튼 복원 → 재클릭 가능).
        removeIframe(w);
        removeVerified(w);
        if (w.triggerBtn) w.triggerBtn.hidden = false;
        w.phase = 'idle';
        setStatus(w, '확인에 실패했습니다. 다시 시도해 주세요');
      }
      break;
    case 'agami-ready': // 첫 표시 완료 — 로딩 표시 제거(로직 불변)
      clearSpinner(w);
      break;
    case 'agami-resize': {
      var h = Number(data.height);
      // verified(접힘, display:none) 또는 iframe 부재 시 높이 적용은 무의미 → 건너뜀.
      if (w.iframe && h > 0 && w.phase !== 'verified') w.iframe.style.height = h + 'px';
      clearSpinner(w);
      break;
    }
    default:
      break;
  }
}

if (typeof window !== 'undefined' && window.addEventListener) {
  window.addEventListener('message', onMessage, false);
}

// ---------------------------------------------------------------------------
// 6. implicit 자동 렌더 (.agami-captcha 스캔 + MutationObserver)
// ---------------------------------------------------------------------------
function renderFromEl(el) {
  if (!el || el.nodeType !== 1) return;
  if (el.getAttribute('data-agami-rendered')) return; // 이미 렌더됨
  renderInto(el, {
    sitekey: el.getAttribute('data-sitekey'),
    kind: el.getAttribute('data-kind') || 'flashlight',
    callback: el.getAttribute('data-callback'),
    errorCallback: el.getAttribute('data-error-callback'),
  });
}

function scanAll(root) {
  var scope = root && root.querySelectorAll ? root : document;
  var nodes = scope.querySelectorAll('.agami-captcha:not([data-agami-rendered])');
  for (var i = 0; i < nodes.length; i++) renderFromEl(nodes[i]);
}

function startAuto() {
  scanAll(document);
  if (typeof MutationObserver === 'undefined') return;
  var mo = new MutationObserver(function (mutations) {
    for (var i = 0; i < mutations.length; i++) {
      var added = mutations[i].addedNodes || [];
      for (var j = 0; j < added.length; j++) {
        var n = added[j];
        if (!n || n.nodeType !== 1) continue;
        if (n.classList && n.classList.contains('agami-captcha')) renderFromEl(n);
        if (n.querySelectorAll) scanAll(n); // 추가된 서브트리 내부도 스캔
      }
    }
  });
  mo.observe(document.documentElement || document.body, { childList: true, subtree: true });
}

// 스크립트가 head/body 어디에 있든, DOMContentLoaded 가 이미 지난 경우도 처리.
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', startAuto);
} else {
  startAuto();
}

// ---------------------------------------------------------------------------
// 7. 공개 API (window.agami)
// ---------------------------------------------------------------------------
var api = {
  /**
   * explicit 렌더.
   * @param {string|Element} el  선택자 또는 DOM 엘리먼트
   * @param {{sitekey?:string,kind?:string,callback?:Function|string,errorCallback?:Function|string}} opts
   * @returns {string|undefined} widgetId
   */
  render: function (el, opts) {
    try {
      var div = resolveEl(el);
      if (!div) { warn('render: 대상을 찾지 못했습니다: ' + el); return; }
      var existing = div.getAttribute('data-agami-rendered');
      if (existing) { warn('render: 이미 렌더된 엘리먼트입니다.'); return existing; }
      return renderInto(div, opts || {});
    } catch (e) {
      warn('render 예외: ' + e); // throw 로 페이지를 죽이지 않는다.
    }
  },

  /** 해당 위젯을 idle 로 되돌림: 토큰/hidden 비우고 iframe·verified 제거, 트리거 버튼 복원.
   *  재도전은 사용자가 트리거 버튼을 다시 클릭 → 새 iframe 마운트 → 새 챌린지. */
  reset: function (widgetId) {
    try {
      var w = widgets[widgetId];
      if (!w) { warn('reset: 알 수 없는 widgetId: ' + widgetId); return; }
      w.token = '';
      setHidden(w, '');
      removeIframe(w); // 재로드(src 갈아끼우기) 대신 제거 → idle 복귀
      removeVerified(w);
      if (w.triggerBtn) w.triggerBtn.hidden = false;
      w.phase = 'idle';
      setStatus(w, '초기화되었습니다');
    } catch (e) {
      warn('reset 예외: ' + e);
    }
  },

  /** 해당 위젯의 현재 토큰 문자열 반환(없으면 빈 문자열). */
  getResponse: function (widgetId) {
    var w = widgets[widgetId];
    return (w && w.token) || '';
  },
};

export default api;
