import { useEffect, useRef, useState } from 'react';
import { detectInstruction, extractEvidence } from '../lib/faceDetection';
import { detectHandGesture, extractHandEvidence, spread, pinchRatio } from '../lib/handDetection';
import FishTimer from './FishTimer';

// =============================================================================
// MediaPipe 라이브러리 CDN 로딩
// -----------------------------------------------------------------------------
// @mediapipe/* npm 패키지는 package.json 의 sideEffects:[] 정책 때문에 Vite
// 8 (Rolldown) production tree-shaker 가 side-effect import 를 통째로 제거한다.
// → 번들에 코드 미포함 → window.FaceMesh undefined → 캡챠 동작 X.
// 해결: <script> 태그로 jsdelivr CDN 에서 직접 로드. MediaPipe 공식 권장 패턴.
// 모듈 레벨 single-flight Promise 로 마운트 횟수와 무관하게 1 회만 로드.
// =============================================================================

const g = /** @type {any} */ (globalThis);

const MP_CDN_SCRIPTS = [
  'https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh/face_mesh.js',
  'https://cdn.jsdelivr.net/npm/@mediapipe/hands/hands.js',
  'https://cdn.jsdelivr.net/npm/@mediapipe/camera_utils/camera_utils.js',
  'https://cdn.jsdelivr.net/npm/@mediapipe/drawing_utils/drawing_utils.js',
];
const MP_LOAD_TIMEOUT_MS = 10000;

let _mpPromise = null;

function loadMediaPipe() {
  if (_mpPromise) return _mpPromise;
  if (typeof document === 'undefined') {
    return Promise.reject(new Error('document not available (SSR?)'));
  }

  const loadScript = (src) => new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[data-mp-src="${src}"]`);
    if (existing) {
      if (existing.dataset.loaded === '1') return resolve();
      existing.addEventListener('load', () => resolve());
      existing.addEventListener('error', () => reject(new Error('script error: ' + src)));
      return;
    }
    const s = document.createElement('script');
    s.src = src;
    s.async = true;
    s.crossOrigin = 'anonymous';
    s.dataset.mpSrc = src;
    s.addEventListener('load', () => { s.dataset.loaded = '1'; resolve(); });
    s.addEventListener('error', () => reject(new Error('script error: ' + src)));
    document.head.appendChild(s);
  });

  const built = new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`MediaPipe CDN 로드 ${MP_LOAD_TIMEOUT_MS}ms 초과`)),
      MP_LOAD_TIMEOUT_MS,
    );
    Promise.all(MP_CDN_SCRIPTS.map(loadScript))
      .then(() => {
        clearTimeout(timer);
        if (
          typeof g.FaceMesh !== 'function'
          || typeof g.Camera !== 'function'
          || typeof g.Hands !== 'function'
        ) {
          return reject(new Error('FaceMesh/Hands/Camera not registered after CDN load'));
        }
        resolve();
      })
      .catch((err) => { clearTimeout(timer); reject(err); });
  });

  // 실패 시 다음 호출에서 재시도 가능하도록 cache 비움
  built.catch(() => { _mpPromise = null; });
  _mpPromise = built;
  return built;
}

// =============================================================================
// 안면 미션 캡챠 (MediaPipe Face Mesh 기반 실시간 자동 감지)
// -----------------------------------------------------------------------------
// 동작 흐름
//   1) 마운트 시 FaceMesh 초기화 + Camera 시작
//   2) 매 프레임 onResults → 랜드마크 추출 → 캔버스에 메쉬 오버레이
//   3) 현재 지시 타입을 detectInstruction 으로 판정. true 가
//      duration_sec 만큼 연속 유지되면 해당 단계 완료, 다음 단계로 자동 진행.
//   4) 모든 단계 완료 시 onSubmit(payload) 1회 호출.
//
// 정리
//   - useEffect cleanup 에서 camera.stop / faceMesh.close / track.stop 모두 수행.
//
// 알려진 한계 (MVP)
//   - 클라이언트 사이드 검출이라 사용자가 마음먹고 우회 가능 (사진/녹화 영상 등).
//   - 진짜 검증은 서버에서 행동 시퀀스 + 시간 + 행동 패턴 종합 분석 필요.
//   - 팀원 AI 모델 합류 시 백엔드로 영상/랜드마크 시퀀스 전송 후 검증으로 교체 예정.
//   - 현재 모델은 클라이언트가 completed_instructions 만 신뢰 보고하는 구조.
// =============================================================================

const ICON_FOR = {
  blink_left: '👁️',
  blink_right: '👁️',
  turn_left: '⬅️',
  turn_right: '➡️',
  smile: '😊',
  nod: '🙇',
};

// A3: 손동작 지시 아이콘 (ICON_FOR 와 동형, 추가).
const HAND_ICON_FOR = {
  open_hand: '🖐️',
  fist: '✊',
  pinch: '🤏',
};

const COLOR_BLUE = '#4a8bff';
const COLOR_YELLOW = '#fbbf24';
const COLOR_WHITE = 'rgba(255, 255, 255, 0.95)';

// MediaPipe WASM/asset CDN. 패키지 버전과 일치하는 디렉터리를 가리킴.
const MP_FACE_MESH_CDN = (file) =>
  `https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh/${file}`;
// A3: Hands WASM/asset CDN (face 와 동형).
const MP_HANDS_CDN = (file) =>
  `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${file}`;

// 카메라 캡처 해상도. Camera 설정과 단일 출처로 공유하고, 증거 페이로드의
// frame_w/frame_h 메타로도 실어 보낸다. (landmark 는 정규화 좌표라 기하 계산엔 무관)
const CAMERA_WIDTH = 480;
const CAMERA_HEIGHT = 480;

// 원시 랜드마크 증거 버퍼링 파라미터 (A1).
const EVIDENCE_FPS = 15;
const EVIDENCE_MIN_INTERVAL_MS = 1000 / EVIDENCE_FPS; // 15fps 다운샘플
const MAX_EVIDENCE_FRAMES = 150; // instruction당 상한 = 15fps × 10s


export default function FaceMissionCaptcha({ spec, onSubmit, onRefresh, embedded = false }) {
  // DOM
  const videoRef = useRef(null);
  const canvasRef = useRef(null);

  // MediaPipe 인스턴스
  const faceMeshRef = useRef(null);
  const cameraRef = useRef(null);
  const handsRef = useRef(null); // A3: MediaPipe Hands (face 와 병렬)
  // A3[2] FPS 계측 — face+hand 동시 송신의 실효 처리율 측정용.
  const fpsCountRef = useRef(0);
  const fpsWindowStartRef = useRef(0);
  const fpsSendMsRef = useRef(0);
  // A3[3]: hand 트랙 상태 (face refs 와 동형, 병렬). face refs 는 무수정.
  const handIdxRef = useRef(0);
  const handProgressStartedAtRef = useRef(null);
  const handCompletedRef = useRef([]);
  const handEvidenceRef = useRef([]); // [{type, completed_at_t, frames:[{t, landmarks}]}]
  const lastHandEvidenceAtRef = useRef(0);
  const faceAllDoneRef = useRef(false); // 마지막 face 지시 완료 여부
  const handAllDoneRef = useRef(false); // 마지막 hand 지시 완료 여부 (hand 없으면 true)

  // 콜백/상태 미러 ref (onResults 안에서 stale closure 회피)
  const onSubmitRef = useRef(onSubmit);
  const specRef = useRef(spec);
  const instructionIdxRef = useRef(0);
  const progressStartedAtRef = useRef(null);
  const noseHistoryRef = useRef([]); // NOD 검출용
  const completedRef = useRef([]);
  const startedAtRef = useRef(Date.now());
  const submittedRef = useRef(false);
  const advanceTimerRef = useRef(null);
  const evidenceRef = useRef([]); // instruction별 증거 버퍼 [{type, frames:[{t, landmarks}]}]
  const lastEvidenceAtRef = useRef(0); // 마지막 증거 기록 시각 (다운샘플 throttle)

  // 렌더 트리거용 상태
  const [detectionStatus, setDetectionStatus] = useState('initializing');
  // initializing | no_face | instruction_active | instruction_complete | denied | error
  const [currentInstructionIndex, setCurrentInstructionIndex] = useState(0);
  const [progressFraction, setProgressFraction] = useState(0);
  const [currentHandIndex, setCurrentHandIndex] = useState(0); // A3: hand 지시 인덱스
  const [handDetected, setHandDetected] = useState(false); // A3: 현재 hand 제스처 충족 표시
  const [timeLeft, setTimeLeft] = useState(spec?.time_limit_sec ?? 30);
  const [hintVisible, setHintVisible] = useState(false);
  const [errorMessage, setErrorMessage] = useState(null);
  const [mpReady, setMpReady] = useState(
    typeof g.FaceMesh === 'function'
    && typeof g.Camera === 'function'
    && typeof g.Hands === 'function',
  );

  // MediaPipe CDN 사전 로딩 (마운트 1회). 이미 로드돼있으면 즉시 ready.
  useEffect(() => {
    if (mpReady) return;
    let cancelled = false;
    loadMediaPipe()
      .then(() => { if (!cancelled) setMpReady(true); })
      .catch((err) => {
        if (cancelled) return;
        console.error('MediaPipe CDN load failed:', err);
        setDetectionStatus('error');
        setErrorMessage('MediaPipe 라이브러리 로드 실패 — 네트워크 또는 CDN 차단을 확인하세요.');
      });
    return () => { cancelled = true; };
  }, [mpReady]);

  // ref 동기화
  useEffect(() => { onSubmitRef.current = onSubmit; }, [onSubmit]);
  useEffect(() => {
    specRef.current = spec;
    instructionIdxRef.current = 0;
    progressStartedAtRef.current = null;
    noseHistoryRef.current = [];
    completedRef.current = [];
    evidenceRef.current = [];
    lastEvidenceAtRef.current = 0;
    submittedRef.current = false;
    // A3: hand 트랙 리셋 (face 와 동형). hand 없는 spec 이면 handAllDone=true(하위호환).
    handIdxRef.current = 0;
    handProgressStartedAtRef.current = null;
    handCompletedRef.current = [];
    handEvidenceRef.current = [];
    lastHandEvidenceAtRef.current = 0;
    faceAllDoneRef.current = false;
    handAllDoneRef.current = !(spec?.hand_instructions && spec.hand_instructions.length > 0);
    startedAtRef.current = Date.now();
    setCurrentInstructionIndex(0);
    setProgressFraction(0);
    setCurrentHandIndex(0);
    setHandDetected(false);
    setTimeLeft(spec?.time_limit_sec ?? 30);
    setHintVisible(false);
  }, [spec]);

  // 디스플레이용 카운트다운 + 힌트 (자동 fail 은 useCaptcha 훅이 처리)
  useEffect(() => {
    if (!spec) return;
    const tick = setInterval(() => {
      setTimeLeft((t) => {
        if (t <= 1) { clearInterval(tick); return 0; }
        return t - 1;
      });
    }, 1000);
    let hintTimer;
    if (spec.hint_after_sec) {
      hintTimer = setTimeout(() => setHintVisible(true), spec.hint_after_sec * 1000);
    }
    return () => { clearInterval(tick); if (hintTimer) clearTimeout(hintTimer); };
  }, [spec]);

  // ---------------------------------------------------------------------------
  // MediaPipe + Camera 초기화 (mpReady=true 이후 1회)
  // ---------------------------------------------------------------------------
  useEffect(() => {
    if (!mpReady) return;  // CDN 로딩 대기
    if (!videoRef.current || !canvasRef.current) return;

    // 방어용 가드 — CDN 로드 성공 후에도 만약 등록 안 됐다면 명확히 에러로 떨어뜨림.
    if (typeof g.FaceMesh !== 'function' || typeof g.Camera !== 'function') {
      setDetectionStatus('error');
      setErrorMessage('MediaPipe 심볼 등록 실패 — 페이지 새로고침 후 재시도하세요.');
      return;
    }

    const video = videoRef.current;
    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');

    let cancelled = false;

    const faceMesh = new g.FaceMesh({ locateFile: MP_FACE_MESH_CDN });
    faceMesh.setOptions({
      maxNumFaces: 1,
      refineLandmarks: true,
      minDetectionConfidence: 0.5,
      minTrackingConfidence: 0.5,
    });

    faceMesh.onResults((results) => handleResults(results, canvas, ctx));
    faceMeshRef.current = faceMesh;

    // A3[2]: Hands 를 face 와 병렬로 생성. face 검출 로직(handleResults/faceDetection)
    // 은 무수정 — hands 는 추가만. 이 단계는 토대 확인용으로 제스처/FPS 를 콘솔에 로그.
    const hands = new g.Hands({ locateFile: MP_HANDS_CDN });
    hands.setOptions({
      maxNumHands: 2,
      modelComplexity: 1,
      minDetectionConfidence: 0.7,
      minTrackingConfidence: 0.7,
    });
    hands.onResults(handleHandResults);
    handsRef.current = hands;

    const camera = new g.Camera(video, {
      onFrame: async () => {
        if (cancelled || !faceMeshRef.current) return;
        const t0 = performance.now();
        try {
          await faceMeshRef.current.send({ image: video });
          // A3[2]: face + hand 동시 송신. 둘 다 await. hands 는 추가만.
          if (handsRef.current) {
            await handsRef.current.send({ image: video });
          }
        } catch (err) {
          // 모델이 닫힌 후 들어오는 마지막 frame 등은 무시
          if (!cancelled) console.warn('mp send failed:', err);
        }
        // A3[2] FPS 계측: face+hand 동시 처리의 실효 fps 를 1초 창마다 콘솔 출력.
        // 15fps(EVIDENCE_FPS) 미만이면 증거 다운샘플 목표 미달 → modelComplexity:0
        // 또는 프레임 교대 대안 검토 필요(보고 참조).
        const t1 = performance.now();
        fpsSendMsRef.current += t1 - t0;
        fpsCountRef.current += 1;
        if (fpsWindowStartRef.current === 0) fpsWindowStartRef.current = t1;
        const elapsed = t1 - fpsWindowStartRef.current;
        if (elapsed >= 1000) {
          const fps = (fpsCountRef.current * 1000) / elapsed;
          const avgMs = fpsSendMsRef.current / fpsCountRef.current;
          console.log(
            `[A3 FPS] face+hand 동시: ${fps.toFixed(1)} fps `
            + `(평균 ${avgMs.toFixed(1)} ms/frame, frames=${fpsCountRef.current}) `
            + (fps < EVIDENCE_FPS ? `⚠️ < ${EVIDENCE_FPS}fps` : '✓'),
          );
          fpsCountRef.current = 0;
          fpsSendMsRef.current = 0;
          fpsWindowStartRef.current = t1;
        }
      },
      width: CAMERA_WIDTH,
      height: CAMERA_HEIGHT,
    });
    cameraRef.current = camera;

    camera
      .start()
      .then(() => {
        if (!cancelled) setDetectionStatus('no_face');
      })
      .catch((err) => {
        console.error('camera start failed:', err);
        if (cancelled) return;
        if (err?.name === 'NotAllowedError' || err?.name === 'PermissionDeniedError') {
          setDetectionStatus('denied');
        } else {
          setDetectionStatus('error');
          setErrorMessage(err?.message || String(err));
        }
      });

    return () => {
      cancelled = true;
      if (advanceTimerRef.current) {
        clearTimeout(advanceTimerRef.current);
        advanceTimerRef.current = null;
      }
      try { camera.stop(); } catch (_) {}
      try { faceMesh.close(); } catch (_) {}
      try { hands.close(); } catch (_) {}
      faceMeshRef.current = null;
      cameraRef.current = null;
      handsRef.current = null;
      // Camera 클래스가 만든 stream 도 명시적으로 해제 (LED off 보장)
      const stream = video.srcObject;
      if (stream && typeof stream.getTracks === 'function') {
        stream.getTracks().forEach((t) => {
          try { t.stop(); } catch (_) {}
        });
      }
      video.srcObject = null;
    };
  }, [mpReady]);

  // ---------------------------------------------------------------------------
  // A3[3]: face·hand 둘 다 완료됐을 때만 1회 제출. face 완료(handleResults)와
  // hand 완료(handleHandResults)가 각각 호출하고, 두 트랙 모두 끝났을 때 제출한다
  // (기획: 둘 다 만족해야 클리어). 서버는 face_hit AND hand_hit 로 각각 검증.
  // ---------------------------------------------------------------------------
  function maybeSubmit() {
    if (submittedRef.current) return;
    if (!faceAllDoneRef.current || !handAllDoneRef.current) return;
    const currentSpec = specRef.current;
    if (!currentSpec) return;
    submittedRef.current = true;
    onSubmitRef.current({
      completed_instructions: [...completedRef.current],
      face_behavioral_data: {
        time_taken_ms: Date.now() - startedAtRef.current,
        steps_count: currentSpec.instructions.length,
        evidence_version: 1,
        frame_w: CAMERA_WIDTH,
        frame_h: CAMERA_HEIGHT,
        face_evidence: {
          instructions: evidenceRef.current
            .filter(Boolean)
            .map((b) => ({
              type: b.type,
              completed_at_t: b.completed_at_t ?? null,
              frames: b.frames,
            })),
        },
        hand_evidence: {
          instructions: handEvidenceRef.current
            .filter(Boolean)
            .map((b) => ({
              type: b.type,
              completed_at_t: b.completed_at_t ?? null,
              frames: b.frames,
            })),
        },
      },
    });
  }

  // ---------------------------------------------------------------------------
  // A3[3] hand 결과 콜백 (hands.onResults). face handleResults 와 동형이되 hand refs
  // 에만 쓴다 — face 검출/표시/evidence 로직과 완전 독립. 기대 hand 제스처를
  // duration_sec 연속 유지하면 해당 hand 지시 완료 → completed_at_t 기록 → maybeSubmit.
  // ---------------------------------------------------------------------------
  function handleHandResults(results) {
    if (submittedRef.current) return;
    const currentSpec = specRef.current;
    if (!currentSpec) return;

    const handInsts = currentSpec.hand_instructions || [];
    if (handInsts.length === 0) {
      handAllDoneRef.current = true; // hand 미요구 spec → 즉시 완료(하위호환)
      maybeSubmit();
      return;
    }

    const idx = handIdxRef.current;
    const inst = handInsts[idx];
    if (!inst) {
      handAllDoneRef.current = true;
      maybeSubmit();
      return;
    }

    const lm = results.multiHandLandmarks?.[0];
    if (!lm) {
      // 손 미검출 → 진행 리셋 (face no_face 와 동형)
      handProgressStartedAtRef.current = null;
      setHandDetected(false);
      return;
    }

    // 원시 hand 랜드마크 증거 기록 (face evidence 와 동형, 15fps 다운샘플).
    const nowMs = Date.now();
    const gesture = detectHandGesture(lm);
    if (nowMs - lastHandEvidenceAtRef.current >= EVIDENCE_MIN_INTERVAL_MS) {
      let buf = handEvidenceRef.current[idx];
      if (!buf || buf.type !== inst.type) {
        buf = { type: inst.type, completed_at_t: null, frames: [] };
        handEvidenceRef.current[idx] = buf;
      }
      if (buf.frames.length < MAX_EVIDENCE_FRAMES) {
        buf.frames.push({ t: nowMs, landmarks: extractHandEvidence(lm) });
      }
      lastHandEvidenceAtRef.current = nowMs;
      // 디버그(fist 임계 캘리브레이션용): gesture=null 이어도 spread/pinch 출력.
      console.log(
        `[A3 hand] expect=${inst.type} got=${gesture ?? 'null'} `
        + `spread=${spread(lm).toFixed(3)} pinch=${pinchRatio(lm).toFixed(3)}`,
      );
    }

    // 제스처 검출 + 연속 유지 (face 게이지와 동형).
    const detected = gesture === inst.type;
    setHandDetected(detected);
    if (detected) {
      if (handProgressStartedAtRef.current == null) {
        handProgressStartedAtRef.current = Date.now();
      }
      const elapsed = Date.now() - handProgressStartedAtRef.current;
      const target = inst.duration_sec * 1000;
      if (elapsed >= target) {
        handCompletedRef.current.push(inst.type);
        const evEntry = handEvidenceRef.current[idx];
        if (evEntry) evEntry.completed_at_t = nowMs;
        handProgressStartedAtRef.current = null;
        const nextIdx = idx + 1;
        if (nextIdx >= handInsts.length) {
          handAllDoneRef.current = true;
          maybeSubmit();
        } else {
          handIdxRef.current = nextIdx;
          setCurrentHandIndex(nextIdx);
        }
      }
    } else if (handProgressStartedAtRef.current != null) {
      handProgressStartedAtRef.current = null;
    }
  }

  // ---------------------------------------------------------------------------
  // onResults : 매 프레임 호출 (faceMesh.onResults 콜백)
  // ---------------------------------------------------------------------------
  function handleResults(results, canvas, ctx) {
    if (submittedRef.current) return;

    const currentSpec = specRef.current;
    if (!currentSpec) return;

    // 캔버스 크기 동기화 (video 의 실제 해상도에 맞춤)
    const vw = results.image?.width || 480;
    const vh = results.image?.height || 480;
    if (canvas.width !== vw) canvas.width = vw;
    if (canvas.height !== vh) canvas.height = vh;

    ctx.save();
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const lm = results.multiFaceLandmarks?.[0];
    if (!lm) {
      // 얼굴 미검출
      ctx.restore();
      setDetectionStatus('no_face');
      progressStartedAtRef.current = null;
      setProgressFraction(0);
      return;
    }

    // 코 Y 누적 (NOD 검출용)
    noseHistoryRef.current.push({ y: lm[1].y, t: Date.now() });
    if (noseHistoryRef.current.length > 60) noseHistoryRef.current.shift();

    // 현재 지시
    const idx = instructionIdxRef.current;
    const inst = currentSpec.instructions[idx];

    // 메쉬 오버레이
    drawMesh(ctx, lm, inst?.type);
    ctx.restore();

    if (!inst) return;

    // 원시 랜드마크 증거 기록 (A1). detected/게이지와 독립 — 얼굴이 검출되고 active
    // instruction 이 있는 프레임을 15fps 로 다운샘플해 누적한다(서버 기하검증의 입력).
    const nowMs = Date.now(); // noseHistory(아래 push)와 동일 시간원
    if (nowMs - lastEvidenceAtRef.current >= EVIDENCE_MIN_INTERVAL_MS) {
      let buf = evidenceRef.current[idx];
      if (!buf || buf.type !== inst.type) {
        buf = { type: inst.type, completed_at_t: null, frames: [] };
        evidenceRef.current[idx] = buf;
      }
      if (buf.frames.length < MAX_EVIDENCE_FRAMES) {
        buf.frames.push({ t: nowMs, landmarks: extractEvidence(lm) });
      }
      lastEvidenceAtRef.current = nowMs;
    }

    // 동작 검출 + 진행도 누적
    const detected = detectInstruction(inst.type, lm, noseHistoryRef.current);
    setDetectionStatus(detected ? 'instruction_active' : 'no_face');

    if (detected) {
      if (progressStartedAtRef.current == null) {
        progressStartedAtRef.current = Date.now();
      }
      const elapsed = Date.now() - progressStartedAtRef.current;
      const target = inst.duration_sec * 1000;
      setProgressFraction(Math.min(1, elapsed / target));

      if (elapsed >= target) {
        // 단계 완료
        completedRef.current.push(inst.type);
        // 완료 시각 기록 (증거 프레임 t 와 동일 시간원 nowMs). 마지막 지시면 바로 아래
        // onSubmit 이 호출되므로 페이로드 조립 전에 set 되어야 한다.
        const evEntry = evidenceRef.current[idx];
        if (evEntry) evEntry.completed_at_t = nowMs;
        progressStartedAtRef.current = null;
        setProgressFraction(0);
        setDetectionStatus('instruction_complete');

        const nextIdx = idx + 1;
        if (nextIdx >= currentSpec.instructions.length) {
          // A3: 마지막 face 지시 완료 → face 트랙 완료 표시. 실제 제출은 hand 까지
          // 끝난 뒤 maybeSubmit 이 1회 수행한다(둘 다 만족해야 클리어 — 기획).
          // 위 face 검출/게이지/evidence(completed_at_t 포함) 로직은 무수정.
          faceAllDoneRef.current = true;
          maybeSubmit();
        } else {
          // 0.6s 동안 체크마크 보여주고 다음 단계로
          if (advanceTimerRef.current) clearTimeout(advanceTimerRef.current);
          advanceTimerRef.current = setTimeout(() => {
            instructionIdxRef.current = nextIdx;
            setCurrentInstructionIndex(nextIdx);
            setDetectionStatus('instruction_active');
          }, 600);
        }
      }
    } else {
      // 끊기면 진행 게이지 리셋
      if (progressStartedAtRef.current != null) {
        progressStartedAtRef.current = null;
        setProgressFraction(0);
      }
    }
  }

  if (!spec) return null;

  const totalSteps = spec.instructions.length;
  const currentInstruction = spec.instructions[currentInstructionIndex];
  const currentHandInstruction = spec.hand_instructions?.[currentHandIndex] ?? null; // A3
  const isCompleteFlash = detectionStatus === 'instruction_complete';

  // 임베드(embedded) 시에만: 큰 그림자 대신 옅은 회색 테두리 + shadow-sm(평면형). 직접/단독은 기존 그림자 유지.
  const cardEdge = embedded
    ? 'border border-gray-200 shadow-sm'
    : 'shadow-[0_20px_60px_rgba(70,130,255,0.15)]';

  return (
    <div className={`w-full max-w-[520px] min-w-0 bg-white rounded-xl ${cardEdge} overflow-hidden mx-auto`}>
      {/* Header */}
      <div className="flex items-center justify-between px-6 py-4 bg-gradient-to-r from-[#4a8bff] to-[#6da5ff] text-white">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 bg-white/20 rounded-lg flex items-center justify-center text-lg">
            😶
          </div>
          <div>
            <div className="font-bold text-[15px] leading-tight">안면 미션 캡챠</div>
            <div className="text-xs opacity-85 mt-0.5">카메라가 동작을 자동 감지합니다</div>
          </div>
        </div>
        <div className="flex items-center gap-2 bg-white/20 px-4 py-1.5 rounded-full">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
            <circle cx="12" cy="12" r="9" />
            <path d="M12 7v5l3 2" />
          </svg>
          <span className="font-bold text-sm tabular-nums">{timeLeft}s</span>
        </div>
      </div>

      {/* Body */}
      <div className="px-6 pt-5">
        {/* 단계 카운터 */}
        <div className="flex items-center justify-between mb-3.5">
          <div className="text-xs text-[#8a96ad] font-semibold uppercase tracking-wide">
            진행 상태
          </div>
          <div className="text-sm font-bold text-[#1d2a44] tabular-nums">
            {Math.min(currentInstructionIndex + 1, totalSteps)}<span className="text-[#8a96ad]">/{totalSteps}</span> 단계
          </div>
        </div>

        {/* 카메라 영역 */}
        <div className="relative w-full aspect-square bg-[#0a0a14] rounded-lg overflow-hidden border-2 border-[#1a1a28]">
          <video
            ref={videoRef}
            autoPlay
            playsInline
            muted
            className="absolute inset-0 w-full h-full object-cover"
            style={{ transform: 'scaleX(-1)' }}
          />
          <canvas
            ref={canvasRef}
            className="absolute inset-0 w-full h-full pointer-events-none"
            style={{ transform: 'scaleX(-1)', mixBlendMode: 'screen' }}
          />

          {/* 큰 지시문 (상단 오버레이) */}
          {currentInstruction && (
            <div className="absolute top-3 left-3 right-3 flex justify-center pointer-events-none">
              <div className="inline-flex items-center gap-2 bg-black/60 backdrop-blur px-4 py-2 rounded-full">
                <span className="text-xl leading-none">
                  {ICON_FOR[currentInstruction.type] ?? '🎯'}
                </span>
                <span className="text-white font-bold text-sm">
                  {currentInstruction.label}
                </span>
                <span className="text-white/60 text-xs">
                  ({currentInstruction.duration_sec}s)
                </span>
              </div>
            </div>
          )}

          {/* A3: 손동작 지시 (얼굴 줄 아래에 동시 표시 — face pill 무수정, 추가). */}
          {currentHandInstruction && (
            <div className="absolute top-[3.75rem] left-3 right-3 flex justify-center pointer-events-none">
              <div className={`inline-flex items-center gap-2 backdrop-blur px-4 py-2 rounded-full ${handDetected ? 'bg-emerald-600/70' : 'bg-black/60'}`}>
                <span className="text-xl leading-none">
                  {HAND_ICON_FOR[currentHandInstruction.type] ?? '✋'}
                </span>
                <span className="text-white font-bold text-sm">
                  손: {currentHandInstruction.label}
                </span>
                <span className="text-white/60 text-xs">
                  {handDetected ? '감지됨 ✓' : `(${currentHandInstruction.duration_sec}s)`}
                </span>
              </div>
            </div>
          )}

          {/* 상태 안내 */}
          {detectionStatus === 'initializing' && (
            <div className="absolute inset-0 flex items-center justify-center bg-black/40 text-white text-sm pointer-events-none">
              <div className="flex items-center gap-3">
                <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/30 border-t-white" />
                얼굴 인식 모델 로딩 중…
              </div>
            </div>
          )}

          {detectionStatus === 'no_face' && (
            <div className="absolute bottom-3.5 left-1/2 -translate-x-1/2 bg-black/70 backdrop-blur px-4 py-2 rounded-full text-xs text-white/90 pointer-events-none">
              📷 얼굴이 보이도록 카메라 앞에 위치해주세요
            </div>
          )}

          {detectionStatus === 'denied' && (
            <div className="absolute inset-0 flex flex-col items-center justify-center text-white px-6 text-center bg-black/80">
              <div className="text-3xl mb-2">📷</div>
              <div className="font-bold mb-1">카메라 권한이 필요합니다</div>
              <div className="text-xs text-white/70 mb-4">
                브라우저 주소창의 카메라 아이콘에서 허용 후 새로고침하세요.
              </div>
              <button
                onClick={onRefresh}
                className="bg-white text-[#2563eb] px-4 py-1.5 rounded-lg text-xs font-bold hover:bg-[#eef4ff] transition-colors"
              >
                다시 시도
              </button>
            </div>
          )}

          {detectionStatus === 'error' && (
            <div className="absolute inset-0 flex flex-col items-center justify-center text-white px-6 text-center bg-black/80">
              <div className="text-3xl mb-2">⚠️</div>
              <div className="font-bold mb-1">카메라를 열 수 없습니다</div>
              <div className="text-xs text-white/70 mb-4 break-words">
                {errorMessage || '알 수 없는 오류'}
              </div>
              <button
                onClick={onRefresh}
                className="bg-white text-[#2563eb] px-4 py-1.5 rounded-lg text-xs font-bold hover:bg-[#eef4ff] transition-colors"
              >
                다시 시도
              </button>
            </div>
          )}

          {/* LIVE 표식 */}
          {(detectionStatus === 'instruction_active' || detectionStatus === 'instruction_complete' || detectionStatus === 'no_face') && (
            <div className="absolute top-3.5 right-3.5 bg-white/10 backdrop-blur px-3 py-1.5 rounded-full text-[11px] text-white/80 flex items-center gap-1.5 pointer-events-none">
              <span className="w-1.5 h-1.5 bg-rose-400 rounded-full animate-pulse" />
              LIVE
            </div>
          )}

          {/* 단계 완료 체크마크 */}
          {isCompleteFlash && (
            <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
              <div className="bg-emerald-500/85 text-white text-5xl w-24 h-24 rounded-full flex items-center justify-center shadow-2xl animate-pulse">
                ✓
              </div>
            </div>
          )}

          {hintVisible && detectionStatus !== 'denied' && detectionStatus !== 'error' && (
            <div className="absolute bottom-12 left-1/2 -translate-x-1/2 bg-amber-400/90 text-amber-950 px-4 py-1.5 rounded-full text-xs font-bold pointer-events-none">
              💡 천천히 또렷하게 동작해보세요
            </div>
          )}
        </div>

        {/* 동작 유지 게이지 (instructionProgressMs / duration_sec * 1000) */}
        <div className="mt-3.5 mb-1">
          <div className="flex items-center justify-between text-xs text-[#8a96ad] mb-1.5">
            <span>현재 동작 유지</span>
            <span className="tabular-nums font-semibold text-[#2563eb]">
              {Math.round(progressFraction * 100)}%
            </span>
          </div>
          <div className="w-full h-2 bg-[#f0f4fb] rounded-full overflow-hidden">
            <div
              className="h-full bg-gradient-to-r from-[#4a8bff] to-[#7aa9ff] rounded-full transition-all duration-150"
              style={{ width: `${progressFraction * 100}%` }}
            />
          </div>
        </div>

        {/* 전체 남은 시간 — 물고기 한 마리가 우측에서 좌측으로 헤엄친다 */}
        <FishTimer
          remainingMs={timeLeft * 1000}
          totalMs={spec.time_limit_sec * 1000}
          className="mt-3.5"
        />
      </div>

      {/* Footer */}
      <div className="flex items-center justify-between px-6 py-5">
        <div className="flex items-center gap-2 text-[#8a96ad] text-xs">
          <span>🛡️</span>
          <span>agami로 보호되는 페이지</span>
        </div>
        <div className="flex gap-2">
          <button
            onClick={onRefresh}
            className="bg-transparent border-[1.5px] border-[#e0e7f3] text-[#6b7891] px-4 py-2 rounded-xl text-sm font-semibold hover:border-[#c8dcff] hover:text-[#4a8bff] transition-colors"
          >
            🔄 새로고침
          </button>
        </div>
      </div>
    </div>
  );
}


// ---------------------------------------------------------------------------
// 메쉬 오버레이 — 현재 지시 타입에 따라 관련 부위만 노란색으로 강조
// ---------------------------------------------------------------------------
function drawMesh(ctx, landmarks, currentType) {
  const FACE_OPTS = { color: COLOR_WHITE, lineWidth: 1.5 };
  const BLUE_OPTS = { color: COLOR_BLUE, lineWidth: 1.5 };
  const HIGHLIGHT_OPTS = { color: COLOR_YELLOW, lineWidth: 2.5 };

  const isBlinkLeft = currentType === 'blink_left';
  const isBlinkRight = currentType === 'blink_right';
  const isSmile = currentType === 'smile';
  const isHeadAction = currentType === 'turn_left'
    || currentType === 'turn_right'
    || currentType === 'nod';

  // 캔버스가 CSS scaleX(-1) 로 거울 반전되므로, MediaPipe 의 LEFT_EYE(이미지 좌측)
  // 는 시각적으로 viewer 의 RIGHT 에 나타난다 = 사용자 관점의 RIGHT eye.
  // 따라서 사용자 관점 highlight 매핑은 다음과 같이 뒤집어서 그린다:
  //   사용자 LEFT eye highlight  → FACEMESH_RIGHT_EYE 에 노란색
  //   사용자 RIGHT eye highlight → FACEMESH_LEFT_EYE  에 노란색
  // CDN 로드 후 호출되는 콜백이라 g.drawConnectors / g.FACEMESH_* 는 항상 존재.
  g.drawConnectors(ctx, landmarks, g.FACEMESH_FACE_OVAL, FACE_OPTS);
  g.drawConnectors(ctx, landmarks, g.FACEMESH_LEFT_EYE, isBlinkRight ? HIGHLIGHT_OPTS : BLUE_OPTS);
  g.drawConnectors(ctx, landmarks, g.FACEMESH_RIGHT_EYE, isBlinkLeft ? HIGHLIGHT_OPTS : BLUE_OPTS);
  g.drawConnectors(ctx, landmarks, g.FACEMESH_LIPS, isSmile ? HIGHLIGHT_OPTS : BLUE_OPTS);

  // 코끝 점
  const nose = landmarks[1];
  if (nose) {
    ctx.beginPath();
    ctx.arc(nose.x * ctx.canvas.width, nose.y * ctx.canvas.height, 4, 0, Math.PI * 2);
    ctx.fillStyle = isHeadAction ? COLOR_YELLOW : COLOR_BLUE;
    ctx.fill();
  }
}
