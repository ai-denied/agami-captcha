/**
 * 부모(loader) postMessage 발신용 순수 헬퍼 (Stage 3)
 * ===================================================
 * EmbedEntry 가 사용. 캡차 로직/판정/마우스 추적과 무관한 "부모로 메시지 보내기"만 담당.
 * React 의존이 없어 Node 로 단위 테스트 가능(프론트 테스트 인프라 없이 검증).
 *
 * 후방 호환 원칙:
 *  - host 가 없으면 targetOrigin '*' 로 폴백(직접-iframe 경로 무손상).
 *  - wid 가 없으면 payload 에 wid 키를 넣지 않음(옛 부모와 동일한 메시지 형태).
 */

/**
 * host(부모 origin 후보)를 안전한 targetOrigin 으로 정규화.
 * 유효한 absolute origin 이면 그 origin, 아니면 '*'.
 * @param {string|null|undefined} host
 * @returns {string} origin 또는 '*'
 */
export function resolveTargetOrigin(host) {
  if (!host || typeof host !== 'string') return '*';
  try {
    const origin = new URL(host).origin;
    if (origin && origin !== 'null') return origin;
  } catch {
    // 파싱 실패 → '*'
  }
  return '*';
}

/**
 * payload 에 wid 가 있으면 포함, 없으면 그대로(직접-iframe 호환: wid 키 없음).
 * @param {object} payload
 * @param {string|undefined} wid
 * @returns {object}
 */
export function buildParentMessage(payload, wid) {
  return wid ? { ...payload, wid } : { ...payload };
}

/**
 * 부모 창으로 전송. cross-origin/부모 부재/단독 실행 예외는 삼킨다.
 * @param {Window} targetWindow  보통 window.parent
 * @param {object} payload
 * @param {{wid?:string, targetOrigin?:string}} [opts]
 */
export function postToParent(targetWindow, payload, opts = {}) {
  if (!targetWindow || typeof targetWindow.postMessage !== 'function') return;
  try {
    targetWindow.postMessage(buildParentMessage(payload, opts.wid), opts.targetOrigin || '*');
  } catch {
    // iframe 아님/cross-origin 정책 위반 등 → 무시
  }
}
