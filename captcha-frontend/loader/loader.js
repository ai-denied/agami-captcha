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
  b.style.cssText =
    'all:unset;cursor:pointer;display:flex;align-items:center;gap:14px;width:100%;box-sizing:border-box;' +
    'min-height:60px;padding:0 18px 0 16px;border-radius:12px;position:relative;overflow:hidden;' +
    'transition:transform .15s, box-shadow .2s, border-color .2s;' +
    (dark ? 'background:#23262e;' : 'background:#fff;border:1.5px solid #e3e6ec;');
  var iconBg = dark ? 'rgba(91,139,247,.16)' : 'rgba(91,139,247,.12)';
  var labelColor = dark ? '#fff' : '#2c313b';
  var chevron = dark ? '#7d828c' : '#b6bcc6';
  b.innerHTML =
    '<span aria-hidden="true" style="position:absolute;left:0;top:0;bottom:0;width:5px;background:#5B8BF7;"></span>' +
    '<span aria-hidden="true" style="width:38px;height:38px;border-radius:50%;display:flex;align-items:center;justify-content:center;flex:none;background:' + iconBg + ';">' +
      '<svg width="20" height="20" viewBox="0 0 1196 1196" aria-hidden="true" style="color:' + (dark ? '#8FB2FF' : '#5B8BF7') + '">' + '<path d="M0 0 C0.9 0.6 1.7 1.1 2.6 1.8 C12.1 10.7 15.5 20.4 16.1 33.1 C15.9 46.5 10.3 57.9 4.7 69.8 C1.4 76.6 -1.1 83.7 -3.4 90.9 C-5.1 95.9 -7 99.7 -10 104 C-11 106.3 -12 108.7 -12.9 111.1 C-13.4 112.5 -14 113.8 -14.5 115.1 C-14.7 115.8 -15 116.4 -15.2 117.1 C-16.4 119.9 -17.6 122.6 -18.8 125.4 C-20.8 130.2 -22.5 134.7 -22 140 C-18 149.2 -7.5 155.5 0.5 161.1 C3.4 163.3 5.8 165.7 8.3 168.3 C12.2 172.3 16.6 175.9 21 179.3 C21.7 179.9 22.3 180.4 23 181 C23 181.7 23 182.3 23 183 C23.6 183.2 24.1 183.5 24.7 183.8 C27.4 185.2 29.1 186.9 31.2 189 C31.6 189.3 31.6 189.3 33.4 191.1 C35 193 35 193 35 195 C35.7 195 36.3 195 37 195 C38.3 196.3 38.3 196.3 39.8 198.2 C42.6 201.5 45.5 204.5 48.6 207.5 C56.8 215.5 63.8 224.2 70.6 233.5 C71 234.1 71.4 234.6 71.8 235.2 C72.9 236.7 74 238.2 75.1 239.8 C77 242 77 242 80 243 C81.3 240.8 82.5 238.6 83.8 236.4 C84.2 235.8 84.5 235.2 84.9 234.6 C87.2 230.5 89.2 226.4 91 222 C98 207.8 106.2 194.8 115.7 182.1 C116.2 181.4 116.7 180.6 117.3 179.8 C117.8 179.2 118.3 178.5 118.8 177.8 C120 176 120 176 121 173 C121.7 173 122.3 173 123 173 C123.2 172.5 123.5 171.9 123.7 171.4 C132.4 155.3 149.1 139.3 164 129 C164.7 129 165.3 129 166 129 C166 128.3 166 127.7 166 127 C168.3 125.1 170.6 123.3 173 121.5 C173.7 121 174.4 120.4 175.2 119.9 C191.7 107.8 209.8 97.3 229 90 C229.4 89.8 229.4 89.8 231.6 89 C252.2 80.9 279.1 76 300 85 C311.5 90.8 320.7 100.9 325 113 C338.1 162.3 312.3 226.6 288 269 C284.7 274.5 281.4 279.9 278 285.4 C277 287 277 287 276 289 C275.3 289 274.7 289 274 289 C273.7 289.7 273.5 290.5 273.2 291.2 C268.4 302.4 256.5 312.6 248 321 C247.3 321.7 246.7 322.3 246 323 C246.3 327 247.4 328.8 250.4 331.4 C254.7 335.5 258.2 340 261.9 344.7 C264.6 348.3 267.5 351.8 270.5 355.2 C276 361.9 280.3 369.4 284.7 376.8 C285.9 378.8 287.1 380.8 288.4 382.8 C296.4 395.6 302.8 409.2 308 423.4 C308.8 425.4 309.6 427.4 310.5 429.4 C317.3 445.5 320.9 462 324.2 479 C324.2 479.3 324.2 479.3 324.6 481.1 C329.1 504.2 331.5 526.9 319 548 C316.9 550.9 316.9 550.9 315 553 C314.3 553 313.7 553 313 553 C312.7 554 312.3 555 312 556 C298.2 568.7 280.5 569.6 262.8 569.1 C251.8 568.6 241.6 565.1 231.4 561 C229.7 560.3 227.9 559.6 226.2 558.9 C209.7 552.3 194.9 544.9 180.3 534.7 C179.7 534.2 179.1 533.8 178.4 533.3 C177.8 532.9 177.3 532.5 176.7 532.1 C175 531 175 531 172.9 530 C170.7 528.9 169.2 527.3 167.5 525.5 C163.6 521.6 159.2 517.9 155 514.2 C149.7 509.7 144.8 504.9 140 500 C139.2 499.2 138.4 498.4 137.5 497.5 C128.7 488.7 121.5 479.3 114.4 469.1 C113.1 467.2 111.8 465.3 110.5 463.4 C101.6 450.9 95 438.1 89 424 C88.5 422.8 87.9 421.5 87.4 420.2 C84 412.3 84 412.3 84 410 C83.3 409.7 82.7 409.3 82 409 C81.7 408 81.3 407 81 406 C79.7 406 78.4 406 77 406 C75.3 408 73.9 410 72.4 412.2 C71.5 413.5 70.6 414.8 69.7 416.1 C69.3 416.8 68.8 417.4 68.3 418.1 C60 429.9 49.3 439.9 39 450.1 C35.4 453.6 31.8 457.2 28.2 460.9 C21.2 468 14.3 474.9 6.4 481.1 C4 483 1.7 485 -0.6 487.1 C-12.7 498 -12.7 498 -16 498 C-16 498.7 -16 499.3 -16 500 C-17.8 501.5 -17.8 501.5 -20.4 503.2 C-21.3 503.8 -22.2 504.4 -23.1 505.1 C-24.1 505.7 -25 506.4 -26 507 C-51.1 524.3 -51.1 524.3 -54.7 539 C-58.2 557.8 -52.6 574.1 -44.9 591 C-43.4 594.2 -42 597.5 -40.6 600.7 C-40.1 601.8 -39.7 602.9 -39.2 604 C-36.9 609.8 -36.8 615.1 -36.8 621.2 C-36.7 621.6 -36.7 621.6 -36.7 623.7 C-36.6 634.9 -41 643.6 -48.7 651.8 C-50.4 653.3 -52.1 654.7 -54 656 C-54.7 656.5 -55.4 657 -56.1 657.5 C-88.9 678.9 -144.1 675.7 -180.8 668.2 C-198.6 664.5 -216.3 660.3 -233 653 C-234.8 652.3 -236.6 651.5 -238.4 650.8 C-240.6 649.9 -242.8 649 -245 648 C-245.7 647.7 -246.5 647.4 -247.2 647 C-261.3 640.9 -274 633.2 -286.8 624.5 C-289 623 -289 623 -291.1 622 C-293.9 620.5 -295.8 618.2 -298 616 C-299.9 614.5 -301.9 613.1 -303.9 611.7 C-308.4 608.4 -312.1 605 -315.6 600.6 C-318.9 596.8 -322.5 596.5 -327.2 595.9 C-328.8 595.7 -330.2 595.5 -331.7 595.3 C-332.5 595.2 -333.3 595.1 -334.1 595 C-356.7 592.1 -378.8 588.4 -400.5 581.8 C-403 581 -405.4 580.3 -407.9 579.6 C-426.5 574.3 -444.7 567.6 -462 559 C-463.3 558.4 -464.6 557.7 -465.9 557.1 C-473.8 553.2 -481.7 549.1 -489.5 544.9 C-492.3 543.4 -495 542 -498 541 C-498 540.3 -498 539.7 -498 539 C-500.3 538.3 -502.6 537.7 -505 537 C-505 536.3 -505 535.7 -505 535 C-505.8 534.8 -506.6 534.6 -507.3 534.4 C-512.6 532.4 -516.9 529.2 -521.5 526 C-522.5 525.3 -523.5 524.6 -524.5 524 C-532 518.7 -539.5 513.4 -547 508 C-548.1 507.2 -549.2 506.4 -550.3 505.7 C-551.3 505 -552.3 504.2 -553.4 503.5 C-554.3 502.9 -555.2 502.2 -556.1 501.6 C-556.7 501.1 -557.4 500.5 -558 500 C-558 499.3 -558 498.7 -558 498 C-558.5 497.8 -559.1 497.6 -559.6 497.3 C-562.8 495.6 -565.5 493.2 -568.2 490.9 C-568.8 490.4 -569.4 489.9 -570 489.4 C-573.9 486 -577.6 482.5 -581.2 478.8 C-583.7 476.3 -586.3 474 -589 471.7 C-591.5 469.6 -593.7 467.3 -596 465 C-596.9 464.1 -597.8 463.3 -598.6 462.4 C-603.4 457.7 -608 453 -612.3 447.9 C-614.2 445.8 -616.2 443.9 -618.2 441.9 C-624.1 436.1 -629 429.6 -634 423 C-634.2 422.7 -634.2 422.7 -635.5 421 C-638.6 416.9 -641.6 412.9 -644.7 408.8 C-645.8 407.2 -647 405.6 -648.2 404 C-653.5 396.9 -658.3 389.5 -663 382 C-663.4 381.4 -663.8 380.8 -664.1 380.2 C-672 367.5 -679.6 354.3 -684 340 C-684.2 339.3 -684.5 338.6 -684.7 337.9 C-688 325.6 -686.9 310.6 -682 299 C-681.3 299 -680.7 299 -680 299 C-679.9 298.3 -679.8 297.6 -679.7 296.8 C-679 293.8 -677.9 291.7 -676.4 289.1 C-675.9 288.1 -675.4 287.1 -674.8 286.1 C-674.2 285.1 -673.6 284.1 -673 283 C-672.4 281.9 -671.8 280.8 -671.1 279.6 C-666.9 272 -662.3 264.9 -657.3 257.8 C-655.9 255.8 -654.5 253.8 -653.1 251.9 C-647 243.1 -640.6 234.4 -634 226 C-633.3 225.1 -632.7 224.3 -632 223.4 C-625.1 214.6 -617.6 206.5 -609.6 198.7 C-605.9 194.8 -602.3 190.7 -599.1 186.4 C-596 182.9 -592.5 180 -589 177 C-587.2 175.5 -585.4 173.9 -583.6 172.4 C-582.4 171.4 -581.2 170.3 -579.9 169.3 C-577.5 167.2 -575.1 165.1 -572.9 162.9 C-570.9 160.9 -568.8 159.2 -566.5 157.4 C-565.8 156.9 -565 156.3 -564.2 155.7 C-563.5 155.1 -562.8 154.6 -562 154 C-561.3 153.4 -560.6 152.9 -559.8 152.3 C-558 151 -558 151 -556 151 C-555.7 150 -555.3 149 -555 148 C-553.5 146.7 -553.5 146.7 -551.6 145.4 C-550.9 144.9 -550.2 144.4 -549.5 143.9 C-548.8 143.4 -548 142.9 -547.2 142.4 C-546.5 141.8 -545.7 141.3 -544.9 140.8 C-543.4 139.7 -541.8 138.6 -540.2 137.5 C-538.3 136.2 -536.4 134.8 -534.4 133.5 C-527.1 128.3 -519.6 123.6 -512 119 C-511.2 118.5 -510.3 118 -509.4 117.4 C-503.8 113.9 -497.9 110.9 -491.9 107.9 C-486.9 105.5 -481.9 102.8 -477 100.1 C-470.2 96.4 -463.2 94 -455.8 91.8 C-454 91 -454 91 -453 89 C-452 89 -451 89 -450 89 C-448 88 -446 87 -444 86 C-441.4 85 -438.9 84.2 -436.3 83.3 C-435.6 83 -434.9 82.8 -434.1 82.5 C-431.7 81.8 -429.4 81 -427 80.2 C-426.2 79.9 -425.4 79.7 -424.6 79.4 C-412.5 75.4 -400.4 71.7 -388 68.5 C-386.1 68 -384.1 67.5 -382.2 66.9 C-379.6 66.2 -377.3 65.7 -374.6 65.4 C-371 65 -371 65 -370 64 C-368.4 63.8 -366.7 63.6 -365.1 63.5 C-360.2 63.1 -360.2 63.1 -358 62 C-355.1 61.7 -352.3 61.5 -349.4 61.3 C-347 61 -347 61 -346 60 C-342.4 59.7 -338.7 59.5 -335.1 59.4 C-329.1 59.1 -329.1 59.1 -328 58 C-325.4 57.8 -322.9 57.6 -320.2 57.5 C-319.4 57.5 -318.6 57.4 -317.7 57.4 C-312.2 57.1 -306.8 57 -301.4 57.1 C-269 57.7 -269 57.7 -259 48.2 C-257.6 46.8 -256.3 45.4 -255 44 C-254.3 44 -253.7 44 -253 44 C-252.7 43 -252.3 42 -252 41 C-246.5 36 -246.5 36 -244 36 C-244 35.3 -244 34.7 -244 34 C-243.5 33.7 -242.9 33.4 -242.4 33.1 C-237 30.2 -232.1 27 -227.2 23.4 C-225 22 -225 22 -222 22 C-222 21.3 -222 20.7 -222 20 C-221.3 19.7 -220.6 19.3 -219.9 19 C-215.3 16.7 -210.8 14.4 -206.3 12 C-198.4 7.7 -190.5 4 -182 1 C-181.2 0.7 -180.4 0.4 -179.6 0.1 C-155.9 -8.7 -131.2 -14.8 -106 -17 C-105.5 -17.1 -105.5 -17.1 -102.8 -17.3 C-70.1 -20.3 -27.5 -20.6 0 0 Z M-156.8 36.1 C-159.2 37.1 -161.7 37.8 -164.2 38.5 C-167.9 39.6 -170.9 41 -174.2 43 C-176.2 44.1 -178.3 44.9 -180.4 45.8 C-192.6 50.5 -204.1 56.9 -215 64 C-215.8 64.5 -216.7 65.1 -217.6 65.7 C-228.1 72.8 -237.5 81.5 -246.9 90.1 C-249 92 -249 92 -251 93 C-251 93.7 -251 94.3 -251 95 C-251.8 95.3 -252.6 95.6 -253.4 95.9 C-256 97 -256 97 -258 98 C-260.5 98 -262.9 98 -265.4 97.9 C-287 97.7 -308.7 99.4 -330.2 101.6 C-331.5 101.7 -332.8 101.8 -334.1 102 C-342.9 102.9 -342.9 102.9 -344 104 C-345.4 104.2 -346.9 104.3 -348.4 104.4 C-349.3 104.5 -350.2 104.6 -351.1 104.7 C-353 104.8 -354.9 104.9 -356.8 105.1 C-362.2 105.5 -366.9 106.4 -372.1 108.3 C-374.4 109.1 -376.7 109.7 -379.1 110.2 C-379.8 110.3 -380.6 110.5 -381.4 110.7 C-381.6 110.7 -381.6 110.7 -383 111 C-382.4 114.7 -381.1 116.1 -378.2 118.4 C-375.5 120.7 -373 123 -370.5 125.5 C-368.6 127.4 -366.6 129.3 -364.6 131.2 C-349 146.4 -349 146.4 -343.7 155.3 C-341.9 158.2 -339.9 160.6 -337.7 163.1 C-333 168.7 -329.3 174.8 -325.6 181.2 C-325.2 181.9 -324.7 182.7 -324.3 183.4 C-324.1 183.8 -324.1 183.8 -323.1 185.5 C-322.7 186 -322.4 186.5 -322 187 C-321.3 187 -320.7 187 -320 187 C-319.9 187.9 -319.8 188.8 -319.8 189.7 C-319 193 -319 193 -317.2 195.2 C-314.7 198.4 -313.6 201.2 -312.2 204.9 C-311 207.9 -309.7 210.8 -308.2 213.7 C-277 277.4 -277.6 353.3 -299.8 419.5 C-305.5 436 -312.5 452.2 -322 467 C-322.7 468.2 -323.5 469.4 -324.2 470.6 C-329.9 480 -336.1 488.5 -343 497 C-346 500.7 -346 500.7 -346 503 C-346.7 503 -347.3 503 -348 503 C-349.2 504.4 -349.2 504.4 -350.6 506.4 C-353.8 510.9 -357.5 514.9 -361.2 518.9 C-363 521 -363 521 -363 523 C-363.6 523.3 -364.2 523.5 -364.8 523.8 C-367.2 525.1 -368.8 526.5 -370.8 528.5 C-371.4 529.1 -372 529.7 -372.6 530.3 C-374 532 -374 532 -374 534 C-375 534.3 -376 534.7 -377 535 C-381.8 539.3 -381.8 539.3 -383 543 C-364.1 548.4 -344.6 552.8 -325 554.4 C-324.1 554.5 -323.2 554.6 -322.3 554.6 C-320.6 554.8 -318.8 554.9 -317.1 555 C-306.9 555.9 -301.1 560.4 -294 567.4 C-280.1 581 -280.1 581 -276 581 C-276 581.7 -276 582.3 -276 583 C-274.6 584.3 -274.6 584.3 -272.7 585.6 C-272.1 586.1 -271.5 586.5 -270.8 587 C-269 588 -269 588 -266 588 C-266 588.7 -266 589.3 -266 590 C-265.3 590 -264.7 590 -264 590 C-264 590.7 -264 591.3 -264 592 C-263.3 592.4 -262.7 592.7 -262 593.1 C-261.1 593.6 -260.1 594.1 -259.2 594.6 C-258.2 595.2 -257.2 595.7 -256.1 596.3 C-254.2 597.4 -252.2 598.4 -250.3 599.5 C-239.6 605.5 -228.4 610.4 -217 615 C-216.7 615.1 -216.7 615.1 -214.9 615.9 C-191.4 625.6 -165.4 632 -139.9 632.2 C-139.1 632.2 -138.2 632.3 -137.3 632.3 C-134.6 632.3 -131.9 632.3 -129.2 632.3 C-128.3 632.3 -127.4 632.3 -126.5 632.3 C-90.4 632.3 -90.4 632.3 -78 624 C-77 621.7 -76.9 620.4 -77.5 618 C-77.8 617.2 -78.1 616.5 -78.4 615.8 C-78.8 615 -79.1 614.2 -79.5 613.4 C-79.8 612.5 -80.2 611.6 -80.6 610.8 C-81.3 608.9 -82 607.1 -82.8 605.3 C-83.2 604.4 -83.5 603.5 -83.9 602.6 C-94.6 576.6 -99.8 549.4 -91 522 C-90.7 520.9 -90.3 519.7 -89.9 518.5 C-83.9 500.9 -70.2 486.5 -55 476.1 C-51.2 473.4 -47.5 470.7 -43.9 467.9 C-43.2 467.4 -42.5 466.9 -41.8 466.4 C-40.5 465.4 -39.1 464.4 -37.8 463.4 C-36.2 462.2 -34.6 460.9 -33 459.8 C-32.2 459.1 -31.3 458.5 -30.5 457.9 C-30.1 457.6 -30.1 457.6 -28.4 456.3 C-28.2 456.1 -28.2 456.1 -27 455 C-27 454.3 -27 453.7 -27 453 C-26.4 452.7 -25.8 452.5 -25.2 452.2 C-22.9 450.9 -21.1 449.4 -19.1 447.6 C-16.8 445.6 -14.5 443.6 -12 441.7 C-11.3 441.1 -10.7 440.6 -10 440 C-10 439.3 -10 438.7 -10 438 C-9.4 437.7 -8.8 437.5 -8.2 437.2 C-5.9 436 -4 434.7 -2 433 C-2 432.3 -2 431.7 -2 431 C-1.4 430.8 -0.9 430.5 -0.3 430.3 C2.5 428.8 4.3 426.9 6.5 424.7 C7.4 423.9 8.3 423 9.2 422.1 C9.6 421.6 9.6 421.6 11.9 419.4 C12.8 418.5 13.7 417.6 14.6 416.7 C19 412.2 23.1 407.8 26.8 402.6 C28.3 400.6 29.9 399.1 31.9 397.6 C33.7 396.2 33.7 396.2 35 395 C35 394.3 35 393.7 35 393 C35.7 393 36.3 393 37 393 C38.3 391.7 38.3 391.7 39.9 389.9 C40.5 389.1 41.1 388.4 41.7 387.7 C42.5 386.8 43.2 385.9 44 385 C45 383.9 45.9 382.8 46.9 381.6 C55.9 371.2 55.9 371.2 59.2 366.6 C64.7 359.2 70 355.2 79 353.4 C87.8 352.3 96 354.4 103.1 359.8 C112.2 368.5 116 382.8 120.5 394.3 C122.5 399.3 124.5 404.2 127 409 C127.7 410.6 128.5 412.2 129.2 413.9 C129.5 414.7 129.9 415.4 130.2 416.2 C130.5 416.8 130.7 417.4 131 418 C131.7 418 132.3 418 133 418 C133.1 418.7 133.2 419.4 133.3 420.2 C137 435.9 151.6 451.2 162 463 C162.3 463.4 162.3 463.4 164.1 465.4 C167.2 469.1 170.6 472.6 174 476 C174.8 476.9 175.7 477.7 176.5 478.6 C182.4 484.6 188.3 489.9 195 495 C195.8 495.6 196.5 496.2 197.3 496.8 C202.7 501 202.7 501 205 501 C205 501.7 205 502.3 205 503 C206.4 504.1 206.4 504.1 208.4 505.4 C208.8 505.6 208.8 505.6 210.6 506.7 C211 507 211 507 213.1 508.2 C213.5 508.4 213.5 508.4 215.5 509.7 C234 520.7 256.3 531.2 278.3 527.6 C281 526.8 282.7 525.6 284.1 523.1 C287.8 513.4 285.7 503.2 284 493.3 C283.9 492.7 283.8 492 283.7 491.4 C279.9 469.2 274.3 447.5 265 427 C264.6 426.1 264.2 425.1 263.8 424.2 C257.9 411.1 251.3 398.8 243 387 C242.6 386.4 242.1 385.7 241.6 385 C230 368.4 216.7 354.9 199.8 343.6 C194.8 340.1 189.1 335.1 187.5 329 C186.5 321.7 188 317 192.1 310.9 C196.3 306.2 201.9 303.1 207.3 300.2 C211.4 297.9 214.9 295 218.4 291.9 C219 291.3 219.7 290.7 220.4 290.1 C232.6 279.3 242.2 266.7 250.1 252.4 C251.5 250 252.9 247.7 254.4 245.3 C257.6 240.2 260 234.8 262.4 229.3 C262.6 228.8 262.6 228.8 263.8 226 C273.1 204.3 279.4 181.5 283.4 158.3 C283.9 155.5 284.5 152.8 285.2 150.1 C286.8 142.9 286.5 135.9 284 129 C280.9 125.3 278.5 123.8 273.8 122.9 C259.3 122.2 245 128.6 232 134.2 C229.7 135.1 227.3 136.1 225 137 C225 137.7 225 138.3 225 139 C224.3 139.1 223.7 139.1 223 139.2 C218.6 140.4 215.2 142.7 211.3 145.2 C210.9 145.4 210.9 145.4 208.8 146.8 C193.5 156.7 177.2 168.4 166 183 C166 183.7 166 184.3 166 185 C165.3 185 164.7 185 164 185 C162.4 186.7 160.9 188.5 159.4 190.4 C159 190.9 159 190.9 156.9 193.4 C155 196 155 196 155 198 C154.3 198 153.7 198 153 198 C151.6 199.8 151.6 199.8 150 202.4 C149.7 202.9 149.7 202.9 148.1 205.5 C144.8 210.9 141.6 216.5 138.3 222 C136.6 225.1 134.7 228.1 132.9 231.1 C127 240.8 122.3 251.1 117.9 261.6 C106.6 288.8 106.6 288.8 95.2 293.9 C87.6 296.3 80.2 295.6 72.9 292.7 C71 292 71 292 68 292 C68 291.3 68 290.7 68 290 C67.2 289.4 66.3 288.7 65.5 288.1 C62.4 285.6 60.3 282.8 58.1 279.6 C55.2 275.6 52.4 272.2 48.8 268.9 C46.7 266.7 44.8 264.3 42.9 261.9 C38.7 256.7 34.2 251.8 29.6 246.9 C27 244.2 24.6 241.5 22.2 238.6 C21.5 237.7 20.8 236.9 20 236 C19.3 236 18.7 236 18 236 C17.7 235 17.3 234 17 233 C15.4 231.3 13.7 229.6 12 228 C11.1 227.1 10.3 226.2 9.4 225.3 C4.6 220.6 -0.1 215.9 -5.3 211.5 C-6.9 210.1 -8.4 208.6 -9.9 207.1 C-12 205 -12 205 -14 205 C-14.3 204.4 -14.5 203.8 -14.8 203.2 C-16.1 200.9 -17.1 199.8 -19.2 198.2 C-19.8 197.7 -20.5 197.2 -21.2 196.7 C-21.9 196.2 -22.6 195.6 -23.3 195.1 C-24.1 194.5 -24.8 193.9 -25.6 193.4 C-32.4 188.2 -39.6 183.7 -47 179.3 C-51.2 176.8 -55.1 174.1 -59 171 C-59.7 171 -60.3 171 -61 171 C-61 170.3 -61 169.7 -61 169 C-62.2 167.9 -63.4 166.9 -64.7 165.9 C-69.6 161.7 -73 157.1 -75 151 C-75.7 142.2 -72.3 135.8 -67.2 129.1 C-66.3 127.8 -65.4 126.6 -64.5 125.4 C-64.1 124.8 -63.6 124.2 -63.2 123.6 C-52.4 108.9 -45.3 92.2 -40.3 74.8 C-37.3 64.4 -33.6 54.6 -29.1 44.7 C-25 35.3 -25 35.3 -26 31 C-29.8 27.7 -34.6 26.9 -39.4 25.9 C-40.2 25.7 -40.9 25.5 -41.7 25.4 C-78.3 17.1 -122.2 21.8 -156.8 36.1 Z M-444.9 132.8 C-447 134 -448.7 134.6 -451 135 C-451 135.7 -451 136.3 -451 137 C-451.7 137.1 -452.3 137.2 -453 137.3 C-456.8 138.2 -460.2 139.8 -463.8 141.5 C-464.5 141.8 -465.2 142.2 -466 142.6 C-480.7 149.7 -495.1 157.2 -508.2 167 C-512 169.7 -516 172.1 -520 174.6 C-520.6 175 -521.3 175.5 -522 176 C-522 176.7 -522 177.3 -522 178 C-522.8 178.3 -523.6 178.6 -524.4 178.9 C-527 180 -527 180 -529 181 C-529 181.7 -529 182.3 -529 183 C-529.3 183.1 -529.3 183.1 -530.7 183.8 C-535.6 186.4 -539.7 190.4 -544 194 C-544.6 194.5 -545.2 195 -545.8 195.5 C-552.4 201.1 -559 206.7 -565 213 C-569.2 217.2 -573.5 221.2 -578 225.2 C-579.4 226.4 -580.7 227.7 -582 229 C-582 229.7 -582 230.3 -582 231 C-582.7 231 -583.3 231 -584 231 C-585.5 232.7 -586.9 234.4 -588.3 236.2 C-590.7 239.2 -593 242 -595.8 244.7 C-598 247 -598 247 -598 249 C-598.7 249 -599.3 249 -600 249 C-601.4 250.7 -602.8 252.5 -604.1 254.3 C-604.5 254.9 -604.9 255.4 -605.3 256 C-606.6 257.6 -607.8 259.3 -609 261 C-609.7 261.9 -610.4 262.9 -611 263.8 C-612.4 265.6 -613.7 267.4 -615 269.2 C-617.1 272.2 -619.3 275.1 -621.6 278 C-628.2 286.9 -633.9 296.2 -639 306 C-639.4 306.7 -639.8 307.5 -640.2 308.2 C-643.4 314.4 -645.9 320 -644 327 C-636.5 349.4 -622.8 370.8 -607.3 388.4 C-605.6 390.5 -604.4 392.7 -603 395 C-601.2 397.3 -599.3 399.4 -597.4 401.6 C-593.6 406 -589.9 410.4 -586.2 414.9 C-582.9 419 -579.4 422.7 -575.6 426.3 C-574 428 -574 428 -572 431 C-571.3 431 -570.7 431 -570 431 C-569.7 431.6 -569.5 432.3 -569.2 432.9 C-568 435 -568 435 -565 436 C-565 436.7 -565 437.3 -565 438 C-563.4 439.7 -561.7 441.4 -560 443 C-559.6 443.4 -559.6 443.4 -557.8 445.3 C-556 447 -556 447 -554 447 C-554 447.7 -554 448.3 -554 449 C-552.3 450.6 -550.5 452.1 -548.6 453.6 C-547.6 454.4 -546.6 455.3 -545.6 456.1 C-543 458 -543 458 -541 458 C-540.8 458.5 -540.8 458.5 -540 461 C-538 462.8 -535.9 464.4 -533.8 466.1 C-533.1 466.6 -532.5 467 -531.8 467.5 C-530.5 468.6 -529.2 469.6 -527.9 470.6 C-526.2 471.8 -524.6 473.1 -522.9 474.4 C-510.7 484.1 -497.7 492.7 -484.3 500.6 C-482.3 501.8 -480.3 503 -478.3 504.2 C-466.5 511.5 -454.3 518 -441.8 524.1 C-440.6 524.6 -439.4 525.2 -438.2 525.8 C-433.2 527.7 -433.2 527.7 -430 527 C-427.5 525.4 -425.3 523.4 -423.1 521.4 C-422.5 520.9 -421.9 520.3 -421.2 519.8 C-417.6 516.5 -414 513.1 -410.6 509.6 C-408.8 507.8 -407 506.3 -405.2 504.7 C-379.9 482.8 -356.5 451.9 -344.4 420.7 C-343.2 417.6 -341.9 414.6 -340.6 411.6 C-334 395.7 -328.6 379 -326 362 C-325.8 360.9 -325.6 359.7 -325.5 358.6 C-324.1 348.6 -323.7 338.8 -323.7 328.8 C-323.7 326.2 -323.7 323.6 -323.6 321.1 C-323.6 309.5 -324.8 298.4 -327 287 C-327.1 286.3 -327.3 285.6 -327.4 284.9 C-331 266.4 -337.9 248.3 -345 231 C-345.7 231 -346.3 231 -347 231 C-347.1 230 -347.1 229.1 -347.2 228.1 C-347.9 223.1 -350.3 219 -352.8 214.6 C-353.3 213.8 -353.8 212.9 -354.3 212 C-359.3 203.2 -365 195.1 -371 187 C-372.6 184.9 -374.1 182.7 -375.7 180.6 C-376 180.1 -376 180.1 -377.6 178 C-379 176 -379 176 -380 174 C-380.7 174 -381.3 174 -382 174 C-382.3 173.4 -382.5 172.8 -382.8 172.2 C-384.7 168.6 -387.5 165.9 -390.3 162.9 C-390.9 162.3 -391.6 161.6 -392.2 160.9 C-397.2 155.7 -402.4 151 -408 146.4 C-411.5 143.6 -414.9 140.6 -418.2 137.6 C-420.9 135.2 -422.3 134 -426 134 C-426 133.3 -426 132.7 -426 132 C-426.7 132 -427.3 132 -428 132 C-428 131.3 -428 130.7 -428 130 C-434.2 126.9 -439.5 129.4 -444.9 132.8 Z " fill="currentColor" transform="translate(778,271)"/><path d="M0 0 C6.8 5.3 13.3 12.1 15.2 20.7 C16.3 29.7 16.1 37.5 11.1 45.3 C7.9 49.4 4.4 52.7 0.2 55.7 C-0.5 56.3 -1.2 56.8 -1.9 57.3 C-8.4 61.7 -15.2 61.9 -22.8 60.7 C-27.1 59.2 -30.9 57.2 -34.8 54.7 C-35.4 54.4 -36 54 -36.7 53.6 C-41.8 49.9 -45.8 43.4 -47.4 37.4 C-48.8 26.9 -48.4 17.7 -42.5 8.8 C-32.8 -3.6 -13.9 -8.4 0 0 Z " fill="currentColor" transform="translate(634.8,490.3)"/><path d="M0 0 C11.5 8.7 20.2 18.5 23 33 C24 44.4 21.7 54.2 16 64 C15.6 64.7 15.2 65.4 14.8 66.1 C11.8 70.9 7.8 73.8 3.1 76.9 C2.5 77.3 1.9 77.6 1.3 78 C-7.7 83.6 -18.7 85.1 -29.1 83.4 C-37.1 81.5 -44.9 77.5 -51 72 C-51 71.3 -51 70.7 -51 70 C-51.7 70 -52.3 70 -53 70 C-61 58.9 -65.6 46.7 -64 33 C-61.1 18.4 -53.8 8.1 -41.8 -0.2 C-29.4 -6.7 -11.8 -7.8 0 0 Z " fill="currentColor" transform="translate(326,520)"/><path d="M0 0 C4.5 3.5 7.5 8.2 9.8 13.4 C9.8 14.7 9.8 16 9.8 17.4 C10.4 17.4 11.1 17.4 11.8 17.4 C12.4 29.4 11.4 37.4 3.6 46.7 C-2 52.5 -8.1 56.9 -16.2 57.4 C-16.9 57.4 -17.6 57.5 -18.3 57.5 C-28.1 58 -35.7 54.5 -42.9 48 C-49.3 40.9 -53 32.5 -52.6 22.7 C-51.3 14.2 -47.6 6.3 -41.2 0.4 C-27.6 -8.8 -13.8 -9.2 0 0 Z " fill="currentColor" transform="translate(574.2,575.6)"/>' + '</svg>' +
    '</span>' +
    '<span style="flex:1;font:700 16px system-ui,-apple-system,sans-serif;color:' + labelColor + ';">사람인지 확인</span>' +
    '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M9 6l6 6-6 6" stroke="' + chevron + '" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  
  b.onmouseenter = function () {
    b.style.transform = 'translateY(-1px)';
    if (!dark) { b.style.borderColor = '#5B8BF7'; b.style.boxShadow = '0 2px 12px rgba(91,139,247,.14)'; }
  };
  b.onmouseleave = function () {
    b.style.transform = '';
    if (!dark) { b.style.borderColor = '#e3e6ec'; b.style.boxShadow = ''; }
  };
  b.onclick = onClick; 
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
  v.setAttribute('class', 'agami-verified');
  v.style.cssText =
    'display:flex;align-items:center;gap:14px;width:100%;box-sizing:border-box;' +
    'min-height:60px;padding:0 18px 0 16px;border-radius:12px;position:relative;overflow:hidden;' +
    (dark ? 'background:#23262e;' : 'background:#fff;border:1.5px solid #cdeede;');
  var green = dark ? '#34d399' : '#16a34a';
  var iconBg = dark ? 'rgba(52,211,153,.16)' : 'rgba(22,163,74,.12)';
  v.innerHTML =
    '<span aria-hidden="true" style="position:absolute;left:0;top:0;bottom:0;width:5px;background:' + green + ';"></span>' +
    '<span aria-hidden="true" style="width:38px;height:38px;border-radius:50%;display:flex;align-items:center;justify-content:center;flex:none;background:' + iconBg + ';">' +
      '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5" stroke="' + green + '" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>' +
    '</span>' +
    '<span style="flex:1;font:700 16px system-ui,-apple-system,sans-serif;color:' + green + ';">확인됨</span>';
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

// [핵심 조치 3] 실패 상태 시 표시할 빨간색 알림창 (다시 시도 버튼 포함) UI 생성 함수
function makeFailed(w, errMsg) {
  var dark = w.theme === 'dark';
  var v = document.createElement('div');
  v.setAttribute('class', 'agami-failed');
  v.style.cssText =
    'display:flex;align-items:center;gap:14px;width:100%;box-sizing:border-box;' +
    'min-height:60px;padding:8px 18px 8px 16px;border-radius:12px;position:relative;overflow:hidden;' +
    (dark ? 'background:#23262e;' : 'background:#fff;border:1.5px solid #fecdd3;');
  
  var red = dark ? '#fb7185' : '#e11d48';
  var iconBg = dark ? 'rgba(251,113,133,.16)' : 'rgba(225,29,72,.12)';
  var titleColor = dark ? '#fff' : '#2c313b';
  var descColor = dark ? '#a1a1aa' : '#64748b';

  v.innerHTML =
    '<span aria-hidden="true" style="position:absolute;left:0;top:0;bottom:0;width:5px;background:' + red + ';"></span>' +
    '<span aria-hidden="true" style="width:38px;height:38px;border-radius:50%;display:flex;align-items:center;justify-content:center;flex:none;background:' + iconBg + ';">' +
      '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M18 6L6 18M6 6l12 12" stroke="' + red + '" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>' +
    '</span>' +
    '<div style="flex:1;display:flex;flex-direction:column;justify-content:center;padding:4px 0;">' +
      '<span style="font:700 15px system-ui,-apple-system,sans-serif;color:' + titleColor + ';">검증 실패</span>' +
      '<span style="font:12px system-ui,-apple-system,sans-serif;color:' + descColor + ';">' + errMsg + '</span>' +
    '</div>' +
    '<button type="button" class="agami-retry-btn" style="all:unset;cursor:pointer;background:' + red + ';color:#fff;font:700 13px system-ui,-apple-system,sans-serif;padding:8px 14px;border-radius:8px;transition:opacity 0.2s;white-space:nowrap;flex:none;">다시 시도</button>';
    
  var retryBtn = v.querySelector('.agami-retry-btn');
  retryBtn.onmouseenter = function() { retryBtn.style.opacity = '0.8'; };
  retryBtn.onmouseleave = function() { retryBtn.style.opacity = '1'; };
  retryBtn.onclick = function(e) {
    e.stopPropagation();
    api.reset(w.id); 
    if (w.triggerBtn) w.triggerBtn.click(); // 즉시 다시 열기
  };

  return v;
}

function showFailed(w, errMsg) {
  if (w.failedEl) { removeEl(w.failedEl); w.failedEl = null; }
  w.failedEl = makeFailed(w, errMsg);
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
  overlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.4);z-index:2147483647;display:flex;align-items:center;justify-content:center;backdrop-filter:blur(2px);';

  // 검은 여백을 클릭하면 창 닫기
  overlay.onclick = function (e) {
    if (e.target === overlay) api.reset(w.id);
  };

  var iframe = document.createElement('iframe');
  iframe.src = buildSrc(w.kind, w.sitekey, w.id, w.theme); 
  iframe.title = 'Agami CAPTCHA';
  iframe.setAttribute('frameborder', '0');
  iframe.setAttribute('scrolling', 'no');
  // 배경을 투명으로 하고 모서리를 둥글게하여 React 내부 카드와 혼연일체 되도록 구성
  iframe.style.cssText = 'width:90%;max-width:500px;height:120px;border:0;border-radius:24px;box-shadow:0 20px 60px rgba(0,0,0,0.15);display:block;transition:height 0.2s ease;background:transparent;';
  iframe.setAttribute('sandbox', 'allow-scripts allow-same-origin');
  iframe.setAttribute('allow', 'camera');

  var spinner = makeSpinner();
  spinner.style.position = 'absolute';
  overlay.appendChild(spinner);
  overlay.appendChild(iframe);

  document.body.appendChild(overlay);

  w.iframe = iframe;
  w.overlay = overlay; 

  iframe.onload = function () { clearSpinner(w); };
  w.readyTimer = setTimeout(function () { clearSpinner(w); }, 8000);

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
        if (w.triggerBtn) w.triggerBtn.style.display = 'none';

        var verifyingUi = document.createElement('div');
        var dark = w.theme === 'dark';
        verifyingUi.style.cssText =
          'display:flex;align-items:center;gap:14px;width:100%;box-sizing:border-box;' +
          'min-height:60px;padding:0 18px 0 16px;border-radius:12px;position:relative;overflow:hidden;' +
          (dark ? 'background:#23262e;' : 'background:#fff;border:1.5px solid #e3e6ec;');
        
        var spinnerColor = dark ? '#8FB2FF' : '#5B8BF7';
        var textColor = dark ? '#fff' : '#2c313b';
        verifyingUi.innerHTML =
          '<span style="width:38px;height:38px;display:flex;align-items:center;justify-content:center;flex:none;">' +
            '<style>@keyframes agami-spin { to { transform: rotate(360deg); } }</style>' +
            '<span style="display:block;width:20px;height:20px;border:3px solid ' + (dark ? 'rgba(143,178,255,0.2)' : 'rgba(91,139,247,0.2)') + ';border-top-color:' + spinnerColor + ';border-radius:50%;animation:agami-spin 1s linear infinite;"></span>' +
          '</span>' +
          '<span style="flex:1;font:700 16px system-ui,-apple-system,sans-serif;color:' + textColor + ';">안전한 환경인지 검증 중...</span>';
        
        w.div.appendChild(verifyingUi);
        setStatus(w, '검증을 진행 중입니다');

        setTimeout(function() {
          removeEl(verifyingUi); 
          w.token = data.captchaToken || '';
          setHidden(w, w.token);
          if (w.callback) {
            try { w.callback(w.token); } catch (e) { warn('callback 예외: ' + e); }
          }
          showVerified(w);
          w.phase = 'verified';
          setStatus(w, '확인되었습니다');
        }, 1500);
        
      } else {
        // [핵심 조치] 실패 시 모달 창을 없애고 호스트 페이지 영역에 실패 UI와 다시하기 버튼 표시
        w.token = '';
        setHidden(w, '');
        if (w.errorCallback) {
          try { w.errorCallback(data); } catch (e) { warn('errorCallback 예외: ' + e); }
        }
        
        removeIframe(w); 
        if (w.triggerBtn) w.triggerBtn.style.display = 'none'; 
        
        var errMsg = (data.error && data.error.message) ? data.error.message : '알 수 없는 오류가 발생했습니다.';
        showFailed(w, errMsg); 
        
        w.phase = 'failed';
        setStatus(w, '확인에 실패했습니다: ' + errMsg);
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
