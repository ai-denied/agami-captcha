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
 * iframe → loader 메시지(현재 EmbedEntry 발신, src/ 무수정 가정):
 *   { type:'agami-result', success, challengeId, challengeType, captchaToken }
 *   ※ EmbedEntry 는 wid 를 에코하지 않으므로(현 단계), 위젯 라우팅은
 *      event.source(iframe.contentWindow) 매칭으로 한다. event.data.wid 가
 *      들어오면(향후 Stage 3) 그쪽을 우선 사용한다.
 *   ※ 'agami-ready' / 'agami-resize' 는 iframe 측 미구현(Stage 3). 안 와도
 *      loader 가 깨지면 안 되므로 onload + 타임아웃으로 로딩 표시를 제거한다.
 */

// ---------------------------------------------------------------------------
// 0. loader 자신이 로드된 origin 에서 서비스 origin / embed base 를 유도.
//    (하드코딩 금지 — 로컬/스테이징/운영 어디서든 동작하게.)
// ---------------------------------------------------------------------------
function currentScriptSrc() {
  if (document.currentScript && document.currentScript.src) {
    return document.currentScript.src;
  }
  // currentScript 를 못 잡는 경우(비동기 주입 등): src 에 loader.js 가 든 마지막 script.
  var scripts = document.getElementsByTagName('script');
  for (var i = scripts.length - 1; i >= 0; i--) {
    if (scripts[i].src && scripts[i].src.indexOf('loader.js') !== -1) {
      return scripts[i].src;
    }
  }
  return '';
}

var SCRIPT_SRC = currentScriptSrc();
var SERVICE_ORIGIN = ''; // postMessage origin 검증 기준
var EMBED_BASE = ''; // iframe src 의 베이스 ('.../widget/embed')
try {
  var u = new URL(SCRIPT_SRC, (typeof location !== 'undefined' ? location.href : undefined));
  SERVICE_ORIGIN = u.origin;
  // loader.js 와 embed 는 같은 디렉토리(/widget/) 의 형제 → loader.js 를 embed 로 치환.
  EMBED_BASE = u.href.slice(0, u.href.lastIndexOf('/')) + '/embed';
} catch (e) {
  // 유도 실패: render 시 경고. (그래도 페이지를 죽이지 않는다.)
}

// ---------------------------------------------------------------------------
// 1. 내부 상태
// ---------------------------------------------------------------------------
var widgets = {}; // widgetId -> { id, div, iframe, kind, sitekey, token, callback, errorCallback, readyTimer }
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
// 3. 코어 렌더
// ---------------------------------------------------------------------------
function renderInto(div, opts) {
  opts = opts || {};
  if (!EMBED_BASE) warn('loader origin 을 유도하지 못했습니다. iframe src 가 비정상일 수 있습니다.');

  var id = genId();
  var kind = opts.kind || 'flashlight';
  var sitekey = opts.sitekey || '';
  if (!sitekey) warn('sitekey(data-sitekey) 가 없습니다. 백엔드 기본 키로 폴백될 수 있습니다.');

  var iframe = document.createElement('iframe');
  iframe.src = buildSrc(kind, sitekey, id);
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
  div.appendChild(spinner);
  div.appendChild(iframe);

  var w = {
    id: id,
    div: div,
    iframe: iframe,
    kind: kind,
    sitekey: sitekey,
    token: '',
    callback: resolveCb(opts.callback),
    errorCallback: resolveCb(opts.errorCallback),
    readyTimer: null,
  };
  widgets[id] = w;
  div.setAttribute('data-agami-rendered', id); // 중복 렌더 방지 표식

  // ready 미수신 대비: iframe onload 또는 8초 타임아웃 후 로딩 표시 제거.
  iframe.onload = function () { clearSpinner(w); };
  w.readyTimer = setTimeout(function () { clearSpinner(w); }, 8000);

  return id;
}

// ---------------------------------------------------------------------------
// 4. postMessage 수신 (window 단일 리스너 — 위젯별 분기)
// ---------------------------------------------------------------------------
function findWidget(data, source) {
  // Stage 3 호환: data.wid 가 레지스트리에 있으면 우선.
  if (data && data.wid && widgets[data.wid]) return widgets[data.wid];
  // 현재: source(iframe.contentWindow) 매칭.
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
      } else {
        w.token = '';
        setHidden(w, '');
        if (w.errorCallback) {
          try { w.errorCallback(data); } catch (e) { warn('errorCallback 예외: ' + e); }
        }
      }
      break;
    case 'agami-ready': // Stage 3
      clearSpinner(w);
      break;
    case 'agami-resize': { // Stage 3
      var h = Number(data.height);
      if (h > 0) w.iframe.style.height = h + 'px';
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
// 5. implicit 자동 렌더 (.agami-captcha 스캔 + MutationObserver)
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
// 6. 공개 API (window.agami)
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

  /** 해당 위젯 iframe 을 재로드해 새 토큰을 받게 함. hidden input 값 비움. */
  reset: function (widgetId) {
    try {
      var w = widgets[widgetId];
      if (!w) { warn('reset: 알 수 없는 widgetId: ' + widgetId); return; }
      w.token = '';
      setHidden(w, '');
      clearSpinner(w);
      var spinner = makeSpinner();
      w.div.insertBefore(spinner, w.iframe);
      // cache-buster 로 동일 src 라도 강제 재로드 → EmbedEntry 재마운트 → 새 챌린지.
      w.iframe.src = buildSrc(w.kind, w.sitekey, w.id) + '&_=' + Date.now();
      w.readyTimer = setTimeout(function () { clearSpinner(w); }, 8000);
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
