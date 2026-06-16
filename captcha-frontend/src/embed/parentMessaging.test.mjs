/**
 * parentMessaging 순수 헬퍼 단위 테스트 (Node, 무인프라).
 * 실행: node src/embed/parentMessaging.test.mjs
 * 검증: wid 포함/미포함, targetOrigin host/'*' 폴백, 예외 안전.
 */
import assert from 'node:assert';
import { resolveTargetOrigin, buildParentMessage, postToParent } from './parentMessaging.js';

let pass = 0;
function ok(name, cond) {
  if (cond) { pass += 1; console.log('  ✓ ' + name); }
  else { console.error('  ✗ ' + name); throw new Error('FAILED: ' + name); }
}

// === resolveTargetOrigin ===
ok('host 유효 → 그 origin', resolveTargetOrigin('https://member.example') === 'https://member.example');
ok('host 에 path 있어도 origin 으로 정규화', resolveTargetOrigin('https://member.example/page?x=1') === 'https://member.example');
ok('host 포트 포함 origin 보존', resolveTargetOrigin('http://localhost:3000') === 'http://localhost:3000');
ok('host 없음(null) → *', resolveTargetOrigin(null) === '*');
ok('host 빈 문자열 → *', resolveTargetOrigin('') === '*');
ok('host 비-URL → *', resolveTargetOrigin('not a url') === '*');

// === buildParentMessage ===
const base = { type: 'agami-result', success: true, challengeId: 'c1', challengeType: 'flashlight', captchaToken: 'T' };
const withWid = buildParentMessage(base, 'agami-123');
ok('wid 있으면 포함', withWid.wid === 'agami-123');
ok('wid 포함해도 기존 필드 보존', withWid.type === 'agami-result' && withWid.success === true && withWid.challengeId === 'c1' && withWid.challengeType === 'flashlight' && withWid.captchaToken === 'T');
const noWid = buildParentMessage(base, undefined);
ok('★ wid 없으면 wid 키 자체가 없음(직접-iframe 호환)', !('wid' in noWid));
ok('wid 없어도 기존 필드 동일', noWid.type === 'agami-result' && noWid.captchaToken === 'T');

// === postToParent ===
function fakeWin() {
  const calls = [];
  return { calls, postMessage: (msg, origin) => calls.push({ msg, origin }) };
}

// (A) loader 임베드: wid + host → wid 포함, targetOrigin=host
{
  const win = fakeWin();
  postToParent(win, { type: 'agami-result', success: true, captchaToken: 'TOK' }, { wid: 'w1', targetOrigin: resolveTargetOrigin('https://member.example') });
  ok('postToParent 1회 호출', win.calls.length === 1);
  ok('targetOrigin=host', win.calls[0].origin === 'https://member.example');
  ok('msg.wid 포함', win.calls[0].msg.wid === 'w1');
  ok('msg.captchaToken 보존', win.calls[0].msg.captchaToken === 'TOK');
}

// (B) 직접-iframe(후방호환): wid/host 없음 → '*' + wid 없음
{
  const win = fakeWin();
  postToParent(win, { type: 'agami-result', success: true, captchaToken: 'TOK' }, { wid: undefined, targetOrigin: resolveTargetOrigin(null) });
  ok('★ 후방호환 targetOrigin=*', win.calls[0].origin === '*');
  ok('★ 후방호환 msg 에 wid 없음', !('wid' in win.calls[0].msg));
}

// (C) ready/resize 도 동일 경로로 wid/targetOrigin 반영
{
  const win = fakeWin();
  const to = resolveTargetOrigin('https://member.example');
  postToParent(win, { type: 'agami-ready' }, { wid: 'w9', targetOrigin: to });
  postToParent(win, { type: 'agami-resize', height: 320 }, { wid: 'w9', targetOrigin: to });
  ok('agami-ready wid+host', win.calls[0].msg.type === 'agami-ready' && win.calls[0].msg.wid === 'w9' && win.calls[0].origin === 'https://member.example');
  ok('agami-resize height+wid+host', win.calls[1].msg.type === 'agami-resize' && win.calls[1].msg.height === 320 && win.calls[1].msg.wid === 'w9' && win.calls[1].origin === 'https://member.example');
}

// (D) 예외 안전: 대상 없음 / postMessage throw → throw 하지 않음
{
  let threw = false;
  try {
    postToParent(null, { type: 'agami-ready' }, {});
    postToParent({ postMessage: () => { throw new Error('cross-origin'); } }, { type: 'agami-ready' }, { targetOrigin: 'https://x.example' });
  } catch { threw = true; }
  ok('대상 부재/postMessage 예외에도 throw 안 함', threw === false);
}

console.log('\nALL PASSED — ' + pass + ' assertions');
