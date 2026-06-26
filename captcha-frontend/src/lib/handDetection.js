// =============================================================================
// MediaPipe Hands 랜드마크 → 손동작 판정 유틸 (A3, faceDetection.js 패턴)
// -----------------------------------------------------------------------------
// 모든 함수는 normalized hand landmarks (배열, 각 원소 {x:0..1, y:0..1, z})를
// 받는다. 손 크기로 정규화해 캡처 거리/해상도에 둔감하게 만든다.
//
// ★ 임계(OPEN_TH/FIST_TH/PINCH_TH)는 서버
//   captcha_engine/app/captcha/hand_evidence.py 의 동일 상수와 **반드시 일치**해야
//   한다(단일 출처 — train/serve 정합). 값 변경 시 위젯과 서버를 함께 수정.
// =============================================================================

// MediaPipe Hands 21점 인덱스 (서버 hand_evidence.py 와 동일).
export const HAND_WRIST = 0;
export const HAND_MIDDLE_MCP = 9;
export const HAND_INDEX_TIP = 8;
export const HAND_PINKY_TIP = 20;
export const HAND_THUMB_TIP = 4;
export const HAND_LANDMARK_COUNT = 21;

// 제스처 임계 — 서버 hand_evidence.py 의 OPEN_TH/FIST_TH/PINCH_TH 와 동일(단일 출처).
// 로컬 실측 캘리브레이션: 주먹 spread 0.49~0.68 / pinch 0.30~0.39, 핀치 spread>1.2 /
// pinch 0.10~0.18, 펴기 spread 0.89~1.32 / pinch 0.47~1.05. fist·pinch 가 spread 에서
// 겹쳐 우선순위(pinch→open→fist)로 분리한다. 조정 시 hand_evidence.py 도 함께 바꾼다.
export const OPEN_TH = 0.80;   // spread > OPEN_TH → 손 폄
export const FIST_TH = 0.75;   // spread < FIST_TH (그리고 pinch 아님) → 주먹
export const PINCH_TH = 0.25;  // pinchRatio < PINCH_TH → 엄지-검지 붙음


function dist2D(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** 손 크기 = dist(wrist[0], middle_finger_mcp[9]). 정규화 분모. */
export function handSize(lm) {
  return dist2D(lm[HAND_WRIST], lm[HAND_MIDDLE_MCP]);
}

/** index_tip[8] ~ pinky_tip[20] 거리 / handSize. 손가락 벌어짐. */
export function spread(lm) {
  const size = handSize(lm);
  if (size < 1e-6) return 0;
  return dist2D(lm[HAND_INDEX_TIP], lm[HAND_PINKY_TIP]) / size;
}

/** thumb_tip[4] ~ index_tip[8] 거리 / handSize. 엄지-검지 붙음 정도. */
export function pinchRatio(lm) {
  const size = handSize(lm);
  if (size < 1e-6) return 0;
  return dist2D(lm[HAND_THUMB_TIP], lm[HAND_INDEX_TIP]) / size;
}

/**
 * 단일 손동작 분류 — open_hand / fist / pinch / null.
 * pinch 가 가장 특이적(엄지-검지 접촉)이라 먼저 검사. 서버 hand_evidence.py 는
 * instruction 종류별 독립 임계로 검증하지만, 위젯은 화면 표시·완료 판정을 위해
 * 한 제스처로 분류한다(동일 임계 사용).
 */
export function detectHandGesture(lm) {
  if (!lm) return null;
  if (pinchRatio(lm) < PINCH_TH) return 'pinch';
  if (spread(lm) > OPEN_TH) return 'open_hand';
  if (spread(lm) < FIST_TH) return 'fist';
  return null;
}

/**
 * MediaPipe handedness 라벨 → 사용자 관점 손('left'|'right'|null).
 * 영상이 CSS scaleX(-1) 거울이라 MediaPipe 라벨이 반전된다(로컬 실측 확정):
 *   'Left'  = 사용자 오른손('right'),  'Right' = 사용자 왼손('left').
 * 라벨이 없으면(undefined/null) null.
 */
export function toUserHand(label) {
  if (label === 'Left') return 'right';
  if (label === 'Right') return 'left';
  return null;
}

/**
 * 한 프레임의 normalized hand landmark 21점을 { [idx]: [x, y] } 로 추출.
 * - 좌표는 raw 정규화(0~1) 무변환, 소수 5자리 반올림 (extractEvidence 와 동형).
 * - z 는 서버 기하가 2D 만 쓰므로 제외. 없는 점은 생략.
 * - 21점 전부 담는다(서버는 0/4/8/9/20 만 읽지만, 향후 손가락별 확장 대비).
 *
 * @param {Array<{x:number,y:number,z:number}>} lm
 * @returns {Object<number,[number,number]>}
 */
export function extractHandEvidence(lm) {
  const round5 = (v) => Math.round(v * 1e5) / 1e5;
  const out = {};
  if (!lm) return out;
  for (let i = 0; i < HAND_LANDMARK_COUNT; i += 1) {
    const pt = lm[i];
    if (!pt) continue;
    out[i] = [round5(pt.x), round5(pt.y)];
  }
  return out;
}
