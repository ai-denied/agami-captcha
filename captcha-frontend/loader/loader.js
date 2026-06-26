/**
 * Agami CAPTCHA Loader (Stage 2)
 */

function currentScriptEl() {
  if (document.currentScript && document.currentScript.src) {
    return document.currentScript;
  }
  var scripts = document.getElementsByTagName('script');
  for (var i = scripts.length - 1; i >= 0; i--) {
    if (scripts[i].src && scripts[i].src.indexOf('loader.js') !== -1) {
      return scripts[i];
    }
  }
  return null;
}

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

function readEmbedBaseOverride() {
  var fromAttr = (SCRIPT_EL && SCRIPT_EL.getAttribute) ? SCRIPT_EL.getAttribute('data-embed-base') : null;
  var picked = normalizeEmbedBase(fromAttr);
  if (picked) return picked;
  var fromGlobal = (typeof window !== 'undefined') ? window.AGAMI_EMBED_BASE : null;
  return normalizeEmbedBase(fromGlobal);
}

var SCRIPT_EL = currentScriptEl();
var SCRIPT_SRC = (SCRIPT_EL && SCRIPT_EL.src) || '';
var SERVICE_ORIGIN = ''; 
var EMBED_BASE = ''; 

var EMBED_OVERRIDE = readEmbedBaseOverride();
if (EMBED_OVERRIDE) {
  EMBED_BASE = EMBED_OVERRIDE.base;
  SERVICE_ORIGIN = EMBED_OVERRIDE.origin;
} else {
  try {
    var u = new URL(SCRIPT_SRC, (typeof location !== 'undefined' ? location.href : undefined));
    SERVICE_ORIGIN = u.origin;
    EMBED_BASE = u.href.slice(0, u.href.lastIndexOf('/')) + '/embed';
  } catch (e) {}
}

var widgets = {};
var seq = 0;

function warn(msg) {
  try { console.warn('[agami] ' + msg); } catch (e) {}
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

function resolveCb(cb) {
  if (typeof cb === 'function') return cb;
  if (typeof cb === 'string' && cb && typeof window[cb] === 'function') return window[cb];
  return null;
}

function resolveAuto() {
  return (typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-color-scheme: dark)').matches)
    ? 'dark' : 'light';
}

function buildSrc(kind, sitekey, wid, theme) {
  var parts = [];
  parts.push('kind=' + encodeURIComponent(kind || 'flashlight'));
  if (sitekey) parts.push('client_key=' + encodeURIComponent(sitekey));
  parts.push('wid=' + encodeURIComponent(wid));
  parts.push('host=' + encodeURIComponent(location.origin));
  parts.push('theme=' + encodeURIComponent(theme || 'light')); 
  return EMBED_BASE + '?' + parts.join('&');
}

function makeSpinner(theme) {
  var dark = theme === 'dark';
  var s = document.createElement('div');
  s.style.cssText = 'display:flex;align-items:center;gap:14px;width:90%;max-width:500px;box-sizing:border-box;min-height:60px;padding:0 18px;border-radius:12px;margin-bottom:8px;' + (dark ? 'background:#23262e;color:#fff;' : 'background:#fff;border:1.5px solid #e3e6ec;color:#2c313b;');
  var fishSrc = EMBED_BASE.replace('/embed', '/timer-fish.png');
  s.innerHTML = 
    '<style>@keyframes agami-spin { 100% { transform: rotate(360deg); } }</style>' +
    '<span style="width:38px;height:38px;border-radius:50%;display:flex;align-items:center;justify-content:center;flex:none;background:' + (dark ? 'rgba(91,139,247,.16)' : 'rgba(91,139,247,.12)') + ';">' +
      '<img src="' + fishSrc + '" style="width:22px;height:22px;animation:agami-spin 1s linear infinite;" />' +
    '</span>' +
    '<span style="font:700 16px system-ui,-apple-system,sans-serif;">검증 중입니다...</span>';
  return s;
}

function clearSpinner(w) {
  if (w.readyTimer) { clearTimeout(w.readyTimer); w.readyTimer = null; }
  var searchRoot = w.overlay ? w.overlay : w.div;
  var s = searchRoot.querySelector('[data-agami-loading]');
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

function removeEl(el) {
  if (el && el.parentNode) el.parentNode.removeChild(el);
}

function makeTrigger(onClick, theme) {
  var dark = theme === 'dark';
  var b = document.createElement('button');
  b.setAttribute('type', 'button'); 
  b.setAttribute('class', 'agami-trigger');
  // 애니메이션용 스타일 정의
  var style = document.createElement('style');
  style.textContent = '@keyframes agami-border-spin { 100% { transform: rotate(360deg); } }';
  document.head.appendChild(style);

  b.style.cssText =
    'all:unset;cursor:pointer;display:flex;align-items:center;gap:14px;width:100%;box-sizing:border-box;' +
    'min-height:60px;padding:0 18px 0 16px;border-radius:12px;position:relative;overflow:hidden;border:1.5px solid transparent;' +
    'transition:transform .15s, box-shadow .2s;background:' + (dark ? '#23262e' : '#fff') + ';';
  
  // 테두리 스피너 컨테이너 (비활성 시 투명)
  b.style.border = '1.5px solid ' + (dark ? '#333' : '#e3e6ec');

  b.innerHTML =
    '<span aria-hidden="true" style="position:absolute;left:0;top:0;bottom:0;width:5px;background:#5B8BF7;"></span>' +
    '<span style="width:38px;height:38px;border-radius:50%;display:flex;align-items:center;justify-content:center;flex:none;background:' + (dark ? 'rgba(91,139,247,.16)' : 'rgba(91,139,247,.12)') + ';">' +
      '<svg width="20" height="20" viewBox="0 0 1196 1196" fill="currentColor" style="color:' + (dark ? '#8FB2FF' : '#5B8BF7') + '"><path d="M0 0 C... (기존 SVG 생략) ... Z"/></svg>' +
    '</span>' +
    '<span style="flex:1;font:700 16px system-ui,-apple-system,sans-serif;color:' + (dark ? '#fff' : '#2c313b') + ';">사람인지 확인</span>';

  b.onclick = function() {
    // 클릭 시 테두리 애니메이션 시작
    b.style.border = '1.5px solid #5B8BF7';
    b.style.animation = 'agami-border-spin 1s linear infinite';
    onClick();
  };
  return b;
}

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

function makeVerified(theme) {
  var dark = theme === 'dark';
  var v = document.createElement('div');
  v.style.cssText = 'display:flex;align-items:center;gap:14px;width:90%;max-width:500px;box-sizing:border-box;min-height:60px;padding:0 18px;border-radius:12px;margin-bottom:8px;position:relative;overflow:hidden;' + (dark ? 'background:#23262e;' : 'background:#fff;border:1.5px solid #cdeede;');
  var green = dark ? '#34d399' : '#16a34a';
  var fishSrc = EMBED_BASE.replace('/embed', '/pass.png');
  v.innerHTML =
    '<span style="position:absolute;left:0;top:0;bottom:0;width:5px;background:' + green + ';"></span>' +
    '<span style="width:38px;height:38px;border-radius:50%;display:flex;align-items:center;justify-content:center;flex:none;background:' + (dark ? 'rgba(52,211,153,.16)' : 'rgba(22,163,74,.12)') + ';">' +
      '<img src="' + fishSrc + '" style="width:22px;height:22px;" />' +
    '</span>' +
    '<span style="font:700 16px system-ui,-apple-system,sans-serif;color:' + green + ';">확인됨</span>';
  return v;
}

function showVerified(w) {
  if (!w.verifiedEl) {
    w.verifiedEl = makeVerified(w.theme);
    w.div.appendChild(w.verifiedEl);
  } else {
    w.verifiedEl.hidden = false;
  }
}

function removeVerified(w) {
  if (w.verifiedEl) { removeEl(w.verifiedEl); w.verifiedEl = null; }
}

function makeFailed(w, errMsg) {
  var dark = w.theme === 'dark';
  var v = document.createElement('div');
  v.style.cssText = 'display:flex;align-items:center;gap:14px;width:90%;max-width:500px;box-sizing:border-box;min-height:60px;padding:8px 18px;border-radius:12px;margin-bottom:8px;position:relative;overflow:hidden;' + (dark ? 'background:#23262e;' : 'background:#fff;border:1.5px solid #fecdd3;');
  var red = dark ? '#fb7185' : '#e11d48';
  var fishSrc = EMBED_BASE.replace('/embed', '/fail.png');
  v.innerHTML =
    '<span style="position:absolute;left:0;top:0;bottom:0;width:5px;background:' + red + ';"></span>' +
    '<span style="width:38px;height:38px;border-radius:50%;display:flex;align-items:center;justify-content:center;flex:none;background:' + (dark ? 'rgba(251,113,133,.16)' : 'rgba(225,29,72,.12)') + ';">' +
      '<img src="' + fishSrc + '" style="width:22px;height:22px;" />' +
    '</span>' +
    '<div style="flex:1;display:flex;flex-direction:column;justify-content:center;">' +
      '<span style="font:700 15px system-ui,-apple-system,sans-serif;color:' + (dark ? '#fff' : '#2c313b') + ';">검증 실패</span>' +
      '<span style="font:12px system-ui,-apple-system,sans-serif;color:' + (dark ? '#a1a1aa' : '#64748b') + ';">' + errMsg + '</span>' +
    '</div>' +
    '<button type="button" class="agami-retry-btn" style="all:unset;cursor:pointer;background:' + red + ';color:#fff;padding:8px 14px;border-radius:8px;font:700 13px sans-serif;flex:none;">다시 시도</button>';
    
  v.querySelector('.agami-retry-btn').onclick = function(e) { e.stopPropagation(); api.reset(w.id); if (w.triggerBtn) w.triggerBtn.click(); };
  return v;
}

function showFailed(w, errMsg) {
  if (w.failedEl) { removeEl(w.failedEl); w.failedEl = null; }
  w.failedEl = function makeFailed(w, errMsg) {
  var dark = w.theme === 'dark';
  var v = document.createElement('div');
  v.setAttribute('class', 'agami-failed');
  v.style.cssText = 'display:flex;align-items:center;gap:14px;width:100%;box-sizing:border-box;min-height:60px;padding:8px 18px 8px 16px;border-radius:12px;position:relative;overflow:hidden;' + (dark ? 'background:#23262e;' : 'background:#fff;border:1.5px solid #fecdd3;');
  
  var red = dark ? '#fb7185' : '#e11d48';
  v.innerHTML =
    '<span aria-hidden="true" style="position:absolute;left:0;top:0;bottom:0;width:5px;background:' + red + ';"></span>' +
    '<span aria-hidden="true" style="width:38px;height:38px;border-radius:50%;display:flex;align-items:center;justify-content:center;flex:none;background:' + (dark ? 'rgba(251,113,133,.16)' : 'rgba(225,29,72,.12)') + ';">' +
      '<img src="/fail.png" style="width:22px;height:22px;filter:hue-rotate(280deg);" alt="fail" />' +
    '</span>' +
    '<div style="flex:1;display:flex;flex-direction:column;justify-content:center;padding:4px 0;">' +
      '<span style="font:700 15px system-ui,-apple-system,sans-serif;color:' + (dark ? '#fff' : '#2c313b') + ';">검증 실패</span>' +
      '<span style="font:12px system-ui,-apple-system,sans-serif;color:' + (dark ? '#a1a1aa' : '#64748b') + ';">' + errMsg + '</span>' +
    '</div>' +
    '<button type="button" class="agami-retry-btn" style="all:unset;cursor:pointer;background:' + red + ';color:#fff;font:700 13px system-ui,-apple-system,sans-serif;padding:8px 14px;border-radius:8px;transition:opacity 0.2s;white-space:nowrap;flex:none;">다시 시도</button>';
    
  var retryBtn = v.querySelector('.agami-retry-btn');
  retryBtn.onclick = function(e) { e.stopPropagation(); api.reset(w.id); if (w.triggerBtn) w.triggerBtn.click(); };
  return v;
}(w, errMsg);
  w.div.appendChild(w.failedEl);
}

function removeIframe(w) {
  if (w.iframe) {
    clearSpinner(w);
    if (w.overlay && w.overlay.parentNode) {
      w.overlay.parentNode.removeChild(w.overlay);
    }
    w.iframe = null;
    w.overlay = null;
  }
}

function renderInto(div, opts) {
  opts = opts || {};
  if (!EMBED_BASE) warn('loader origin 을 유도하지 못했습니다. iframe src 가 비정상일 수 있습니다.');

  var id = genId();
  var kind = opts.kind || 'flashlight';
  var sitekey = opts.sitekey || '';
  if (!sitekey) warn('sitekey(data-sitekey) 가 없습니다. 백엔드 기본 키로 폴백될 수 있습니다.');
  var pref = String(opts.theme == null ? 'auto' : opts.theme).toLowerCase().trim();
  if (pref !== 'light' && pref !== 'dark') pref = 'auto';
  var theme = (pref === 'auto') ? resolveAuto() : pref;

  var w = {
    id: id,
    div: div,
    iframe: null,
    kind: kind,
    sitekey: sitekey,
    token: '',
    callback: resolveCb(opts.callback),
    errorCallback: resolveCb(opts.errorCallback),
    readyTimer: null,
    phase: 'idle', 
    triggerBtn: null,
    statusEl: null,
    verifiedEl: null,
    failedEl: null,
    theme: theme, 
  };
  widgets[id] = w;
  div.setAttribute('data-agami-rendered', id); 

  w.statusEl = makeStatus();
  div.appendChild(w.statusEl);

  w.triggerBtn = makeTrigger(function () {
    if (w.phase !== 'idle') return; 
    mountIframe(w);
    w.triggerBtn.style.display = 'none';
    w.phase = 'expanded';
    setStatus(w, '확인을 시작합니다');
  }, theme);
  div.appendChild(w.triggerBtn);

  return id;
}

// [핵심 조치 1] 모달 박스를 완전 제거하고 iframe을 네이티브 모달처럼 사용하여 여백 불일치(블랙 갭) 완벽 해결
function mountIframe(w) {
  var overlay = document.createElement('div');
  overlay.id = w.id + '-overlay';
  overlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.6);z-index:2147483647;display:flex;align-items:center;justify-content:center;backdrop-filter:blur(5px);';
  
  var iframe = document.createElement('iframe');
  iframe.src = buildSrc(w.kind, w.sitekey, w.id, w.theme); 
  
  // [핵심] scrolling="no" 속성 추가 및 스타일 강화
  iframe.setAttribute('scrolling', 'no');
  iframe.style.cssText = 'width:90%;max-width:500px;height:auto;border:none;border-radius:24px;box-shadow:0 0 40px rgba(0,0,0,0.3);background:transparent;overflow:hidden;';
  
  iframe.setAttribute('sandbox', 'allow-scripts allow-same-origin');
  iframe.setAttribute('allow', 'camera');
  
  overlay.appendChild(makeSpinner(w.theme));
  overlay.appendChild(iframe);
  document.body.appendChild(overlay);

  w.iframe = iframe;
  w.overlay = overlay; 
  return iframe;
}

function findWidget(data, source) {
  if (data && data.wid && widgets[data.wid]) return widgets[data.wid];
  for (var k in widgets) {
    if (Object.prototype.hasOwnProperty.call(widgets, k)) {
      if (widgets[k].iframe && widgets[k].iframe.contentWindow === source) return widgets[k];
    }
  }
  return null;
}

function onMessage(event) {
  if (!SERVICE_ORIGIN || event.origin !== SERVICE_ORIGIN) return;
  var data = event.data;
  if (!data || typeof data !== 'object') return;

  var w = findWidget(data, event.source);
  if (!w) return; 

  switch (data.type) {
    case 'agami-result':
      if (data.success) {
        removeIframe(w);
        // 애니메이션 멈춤
        if (w.triggerBtn) {
            w.triggerBtn.style.animation = 'none';
            w.triggerBtn.style.border = '1.5px solid #e3e6ec';
        }
        w.token = data.captchaToken || '';
        setHidden(w, w.token);
        showVerified(w);
        w.phase = 'verified';
      } else {
        removeIframe(w);
        if (w.triggerBtn) {
            w.triggerBtn.style.animation = 'none';
            w.triggerBtn.style.border = '1.5px solid #e3e6ec';
            w.triggerBtn.style.display = 'flex'; // 다시 시도 버튼을 위해 복구
        }
        showFailed(w, (data.error && data.error.message) ? data.error.message : '확인에 실패했습니다.');
        w.phase = 'failed';
      }
      break;
    case 'agami-ready': 
      clearSpinner(w);
      break;
    case 'agami-resize': {
      var h = Number(data.height);
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

function renderFromEl(el) {
  if (!el || el.nodeType !== 1) return;
  if (el.getAttribute('data-agami-rendered')) return; 
  renderInto(el, {
    sitekey: el.getAttribute('data-sitekey'),
    kind: el.getAttribute('data-kind') || 'flashlight',
    callback: el.getAttribute('data-callback'),
    errorCallback: el.getAttribute('data-error-callback'),
    theme: el.getAttribute('data-theme'), 
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
        if (n.querySelectorAll) scanAll(n); 
      }
    }
  });
  mo.observe(document.documentElement || document.body, { childList: true, subtree: true });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', startAuto);
} else {
  startAuto();
}

// [최종 수정] 부모 창에서 개발자 도구 및 화면 비율 감지
if (typeof window !== 'undefined') {
  var lastWidth = window.innerWidth;
  var lastHeight = window.innerHeight;

  window.addEventListener('resize', function() {
    var nw = window.innerWidth;
    var nh = window.innerHeight;

    // 모바일(800px 이하)은 무시
    if (nw <= 800 || lastWidth <= 800) {
      lastWidth = nw;
      lastHeight = nh;
      return;
    }

    // 30% 이상 급격한 변화 시 개발자 도구 감지
    if (Math.abs(nw - lastWidth) / lastWidth > 0.3 || Math.abs(nh - lastHeight) / lastHeight > 0.3) {
      for (var id in widgets) {
        var w = widgets[id];
        // 캡차 모달이 떠 있을 때만 반응
        if (w.overlay) {
          // [핵심] api.reset 대신 실패 UI를 띄우는 로직으로 변경
          removeIframe(w); 
          if (w.triggerBtn) w.triggerBtn.style.display = 'none'; 
          
          var errMsg = '비정상적인 움직임이 감지되었습니다.';
          showFailed(w, errMsg); // 실패 UI 출력
          
          w.phase = 'failed';
          setStatus(w, '확인에 실패했습니다: ' + errMsg);
          
          warn(errMsg);
        }
      }
    }
    lastWidth = nw;
    lastHeight = nh;
  });
}

var api = {
  render: function (el, opts) {
    try {
      var div = resolveEl(el);
      if (!div) { warn('render: 대상을 찾지 못했습니다: ' + el); return; }
      var existing = div.getAttribute('data-agami-rendered');
      if (existing) { warn('render: 이미 렌더된 엘리먼트입니다.'); return existing; }
      var o = opts || {};
      if (o.theme == null) o.theme = div.getAttribute('data-theme');
      return renderInto(div, o);
    } catch (e) {
      warn('render 예외: ' + e); 
    }
  },

  reset: function (widgetId) {
    try {
      var w = widgets[widgetId];
      if (!w) { warn('reset: 알 수 없는 widgetId: ' + widgetId); return; }
      w.token = '';
      setHidden(w, '');
      removeIframe(w); 
      removeVerified(w);
      if (w.failedEl) { removeEl(w.failedEl); w.failedEl = null; } 
      if (w.triggerBtn) w.triggerBtn.style.display = 'flex'; 
      w.phase = 'idle';
      setStatus(w, '초기화되었습니다');
    } catch (e) {
      warn('reset 예외: ' + e);
    }
  },

  getResponse: function (widgetId) {
    var w = widgets[widgetId];
    return (w && w.token) || '';
  },
};

export default api;
