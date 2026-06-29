import { useEffect, useRef, useState } from 'react';
import { detectInstruction, extractEvidence } from '../lib/faceDetection';
import { detectHandGesture, extractHandEvidence, toUserHand, isFingerExtended, fingersMatch } from '../lib/handDetection';
import FishTimer from './FishTimer';

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
  if (typeof document === 'undefined') return Promise.reject(new Error('document not available (SSR?)'));

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
    const timer = setTimeout(() => reject(new Error(`MediaPipe CDN 로드 ${MP_LOAD_TIMEOUT_MS}ms 초과`)), MP_LOAD_TIMEOUT_MS);
    Promise.all(MP_CDN_SCRIPTS.map(loadScript))
      .then(() => {
        clearTimeout(timer);
        if (typeof g.FaceMesh !== 'function' || typeof g.Camera !== 'function' || typeof g.Hands !== 'function') {
          return reject(new Error('FaceMesh/Hands/Camera not registered after CDN load'));
        }
        resolve();
      })
      .catch((err) => { clearTimeout(timer); reject(err); });
  });

  built.catch(() => { _mpPromise = null; });
  _mpPromise = built;
  return built;
}

const ICON_FOR = { blink_left: '👁️', blink_right: '👁️', turn_left: '⬅️', turn_right: '➡️', smile: '😊', nod: '🙇' };
const HAND_ICON_FOR = { open_hand: '🖐️', fist: '✊', pinch: '🤏' };
const HAND_SIDE_LABELS = { left: '왼손', right: '오른손' };
const FINGER_KO = { thumb: '엄지', index: '검지', middle: '중지', ring: '약지', pinky: '새끼' };

const COLOR_BLUE = '#4a8bff';
const COLOR_YELLOW = '#fbbf24';
const COLOR_WHITE = 'rgba(255, 255, 255, 0.95)';

const MP_FACE_MESH_CDN = (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh/${file}`;
const MP_HANDS_CDN = (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${file}`;

const CAMERA_WIDTH = 480;
const CAMERA_HEIGHT = 480;

const EVIDENCE_FPS = 15;
const EVIDENCE_MIN_INTERVAL_MS = 1000 / EVIDENCE_FPS;
const MAX_EVIDENCE_FRAMES = 150; 

const FIXED_TOTAL_STEPS = 3;

export default function FaceMissionCaptcha({ spec, onSubmit, onRefresh, embedded = false }) {
  const videoRef = useRef(null);
  const canvasRef = useRef(null);

  const faceMeshRef = useRef(null);
  const cameraRef = useRef(null);
  const handsRef = useRef(null); 
  const fpsCountRef = useRef(0);
  const fpsWindowStartRef = useRef(0);
  const fpsSendMsRef = useRef(0);

  const handIdxRef = useRef(0);
  const handProgressStartedAtRef = useRef(null);
  const handCompletedRef = useRef([]);
  const handEvidenceRef = useRef([]); 
  const lastHandEvidenceAtRef = useRef(0);
  const faceAllDoneRef = useRef(false); 
  const handAllDoneRef = useRef(false); 

  const onSubmitRef = useRef(onSubmit);
  const specRef = useRef(spec);
  const instructionIdxRef = useRef(0);
  const progressStartedAtRef = useRef(null);
  const noseHistoryRef = useRef([]); 
  const completedRef = useRef([]);
  const startedAtRef = useRef(Date.now());
  const submittedRef = useRef(false);
  const advanceTimerRef = useRef(null);
  const evidenceRef = useRef([]); 
  const lastEvidenceAtRef = useRef(0); 

  const [detectionStatus, setDetectionStatus] = useState('initializing');
  const [currentInstructionIndex, setCurrentInstructionIndex] = useState(0);
  const [progressFraction, setProgressFraction] = useState(0);
  const [currentHandIndex, setCurrentHandIndex] = useState(0); 
  const [handDetected, setHandDetected] = useState(false); 
  const [timeLeft, setTimeLeft] = useState(spec?.time_limit_sec ?? 30);
  const [hintVisible, setHintVisible] = useState(false);
  const [errorMessage, setErrorMessage] = useState(null);
  const [mpReady, setMpReady] = useState(
    typeof g.FaceMesh === 'function' && typeof g.Camera === 'function' && typeof g.Hands === 'function',
  );

  useEffect(() => {
    if (mpReady) return;
    let cancelled = false;
    loadMediaPipe()
      .then(() => { if (!cancelled) setMpReady(true); })
      .catch((err) => {
        if (cancelled) return;
        setDetectionStatus('error');
        setErrorMessage('MediaPipe 라이브러리 로드 실패 — 네트워크 또는 CDN 차단을 확인하세요.');
      });
    return () => { cancelled = true; };
  }, [mpReady]);

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

  useEffect(() => {
    if (!mpReady) return;  
    if (!videoRef.current || !canvasRef.current) return;

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
      maxNumFaces: 1, refineLandmarks: true, minDetectionConfidence: 0.5, minTrackingConfidence: 0.5,
    });
    faceMesh.onResults((results) => handleResults(results, canvas, ctx));
    faceMeshRef.current = faceMesh;

    const hands = new g.Hands({ locateFile: MP_HANDS_CDN });
    hands.setOptions({
      maxNumHands: 2, modelComplexity: 1, minDetectionConfidence: 0.7, minTrackingConfidence: 0.7,
    });
    hands.onResults(handleHandResults);
    handsRef.current = hands;

    const camera = new g.Camera(video, {
      onFrame: async () => {
        if (cancelled || !faceMeshRef.current) return;
        const t0 = performance.now();
        try {
          await faceMeshRef.current.send({ image: video });
          if (handsRef.current) await handsRef.current.send({ image: video });
        } catch (err) {}
        const t1 = performance.now();
        fpsSendMsRef.current += t1 - t0;
        fpsCountRef.current += 1;
        if (fpsWindowStartRef.current === 0) fpsWindowStartRef.current = t1;
        if (t1 - fpsWindowStartRef.current >= 1000) {
          fpsCountRef.current = 0; fpsSendMsRef.current = 0; fpsWindowStartRef.current = t1;
        }
      },
      width: CAMERA_WIDTH, height: CAMERA_HEIGHT,
    });
    cameraRef.current = camera;

    camera.start()
      .then(() => { if (!cancelled) setDetectionStatus('no_face'); })
      .catch((err) => {
        if (cancelled) return;
        if (err?.name === 'NotAllowedError' || err?.name === 'PermissionDeniedError') setDetectionStatus('denied');
        else { setDetectionStatus('error'); setErrorMessage(err?.message || String(err)); }
      });

    return () => {
      cancelled = true;
      if (advanceTimerRef.current) clearTimeout(advanceTimerRef.current);
      try { camera.stop(); } catch (_) {}
      try { faceMesh.close(); } catch (_) {}
      try { hands.close(); } catch (_) {}
      faceMeshRef.current = null; cameraRef.current = null; handsRef.current = null;
      if (video.srcObject) video.srcObject.getTracks().forEach((t) => t.stop());
      video.srcObject = null;
    };
  }, [mpReady]);

  // 💡 진행 상황 중간 제출 
  function submitProgress(isFinal) {
    const currentSpec = specRef.current;
    if (!currentSpec) return;

    const payload = {
      face_behavioral_data: {
        time_taken_ms: Date.now() - startedAtRef.current,
        steps_count: FIXED_TOTAL_STEPS,
        evidence_version: 1,
        frame_w: CAMERA_WIDTH,
        frame_h: CAMERA_HEIGHT,
        face_evidence: { instructions: evidenceRef.current.filter(Boolean).map((b) => ({ type: b.type, completed_at_t: b.completed_at_t ?? null, frames: b.frames })) },
        hand_evidence: { instructions: handEvidenceRef.current.filter(Boolean).map((b) => ({ type: b.type, hand: b.hand ?? null, fingers_state: b.fingers_state ?? null, completed_at_t: b.completed_at_t ?? null, frames: b.frames })) },
      }
    };

    if (isFinal) {
      submittedRef.current = true;
      onSubmitRef.current({ ...payload, completed_instructions: [...completedRef.current], status: 'completed' });
    } else {
      onSubmitRef.current({ ...payload, status: 'progressing' });
      // 중간 제출 후 데이터 초기화 (합산 로직 지원)
      evidenceRef.current = [];
      handEvidenceRef.current = [];
      startedAtRef.current = Date.now();
    }
  }

  function checkAndSubmit() {
    if (submittedRef.current) return;
    if (faceAllDoneRef.current && handAllDoneRef.current) submitProgress(true);
  }

  function handleHandResults(results) {
    if (submittedRef.current) return;
    const currentSpec = specRef.current;
    if (!currentSpec) return;

    const handInsts = currentSpec.hand_instructions || [];
    if (handInsts.length === 0) {
      handAllDoneRef.current = true;
      checkAndSubmit();
      return;
    }

    const idx = handIdxRef.current;
    const inst = handInsts[idx] || handInsts[idx % handInsts.length];
    if (!inst) {
      handAllDoneRef.current = true;
      checkAndSubmit();
      return;
    }

    const handLms = results.multiHandLandmarks || [];
    const handedness = results.multiHandedness || [];
    let pickIdx = inst.hand ? handLms.findIndex((_, i) => toUserHand(handedness[i]?.label) === inst.hand) : 0;
    const lm = pickIdx >= 0 ? handLms[pickIdx] : undefined;

    if (!lm) {
      handProgressStartedAtRef.current = null;
      setHandDetected(false);
      return;
    }

    const observedHand = toUserHand(handedness[pickIdx]?.label); 
    const nowMs = Date.now();
    if (nowMs - lastHandEvidenceAtRef.current >= EVIDENCE_MIN_INTERVAL_MS) {
      const observedFingers = {
        thumb: isFingerExtended(lm, 'thumb'), index: isFingerExtended(lm, 'index'),
        middle: isFingerExtended(lm, 'middle'), ring: isFingerExtended(lm, 'ring'), pinky: isFingerExtended(lm, 'pinky'),
      };
      let buf = handEvidenceRef.current[idx];
      if (!buf || buf.type !== inst.type) {
        buf = { type: inst.type, hand: observedHand, fingers_state: observedFingers, completed_at_t: null, frames: [] };
        handEvidenceRef.current[idx] = buf;
      } else {
        if (buf.hand == null && observedHand != null) buf.hand = observedHand;
        buf.fingers_state = observedFingers; 
      }
      if (buf.frames.length < MAX_EVIDENCE_FRAMES) buf.frames.push({ t: nowMs, landmarks: extractHandEvidence(lm) });
      lastHandEvidenceAtRef.current = nowMs;
    }

    const detected = inst.type === 'finger_pose' ? fingersMatch(lm, inst.fingers || []) : detectHandGesture(lm) === inst.type;
    setHandDetected(detected);

    if (detected) {
      if (handProgressStartedAtRef.current == null) handProgressStartedAtRef.current = Date.now();
      if (Date.now() - handProgressStartedAtRef.current >= inst.duration_sec * 1000) {
        handCompletedRef.current.push(inst.type);
        if (handEvidenceRef.current[idx]) handEvidenceRef.current[idx].completed_at_t = nowMs;
        handProgressStartedAtRef.current = null;
        
        const nextIdx = idx + 1;
        if (nextIdx >= FIXED_TOTAL_STEPS) {
          handAllDoneRef.current = true;
          checkAndSubmit();
        } else {
          handIdxRef.current = nextIdx;
          setCurrentHandIndex(nextIdx);
        }
      }
    } else {
      handProgressStartedAtRef.current = null;
    }
  }

  function handleResults(results, canvas, ctx) {
    if (submittedRef.current) return;
    const currentSpec = specRef.current;
    if (!currentSpec) return;

    if (canvas.width !== (results.image?.width || 480)) canvas.width = results.image?.width || 480;
    if (canvas.height !== (results.image?.height || 480)) canvas.height = results.image?.height || 480;

    ctx.save();
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const lm = results.multiFaceLandmarks?.[0];
    if (!lm) {
      ctx.restore(); setDetectionStatus('no_face'); progressStartedAtRef.current = null; setProgressFraction(0); return;
    }

    noseHistoryRef.current.push({ y: lm[1].y, t: Date.now() });
    if (noseHistoryRef.current.length > 60) noseHistoryRef.current.shift();

    const idx = instructionIdxRef.current;
    const inst = currentSpec.instructions[idx] || currentSpec.instructions[idx % currentSpec.instructions.length];

    drawMesh(ctx, lm, inst?.type);
    ctx.restore();
    if (!inst) return;

    const nowMs = Date.now(); 
    if (nowMs - lastEvidenceAtRef.current >= EVIDENCE_MIN_INTERVAL_MS) {
      let buf = evidenceRef.current[idx];
      if (!buf || buf.type !== inst.type) {
        buf = { type: inst.type, completed_at_t: null, frames: [] };
        evidenceRef.current[idx] = buf;
      }
      if (buf.frames.length < MAX_EVIDENCE_FRAMES) buf.frames.push({ t: nowMs, landmarks: extractEvidence(lm) });
      lastEvidenceAtRef.current = nowMs;
    }

    const detected = detectInstruction(inst.type, lm, noseHistoryRef.current);
    setDetectionStatus(detected ? 'instruction_active' : 'no_face');

    if (detected) {
      if (progressStartedAtRef.current == null) progressStartedAtRef.current = Date.now();
      const elapsed = Date.now() - progressStartedAtRef.current;
      setProgressFraction(Math.min(1, elapsed / (inst.duration_sec * 1000)));

      if (elapsed >= inst.duration_sec * 1000) {
        completedRef.current.push(inst.type);
        if (evidenceRef.current[idx]) evidenceRef.current[idx].completed_at_t = nowMs;
        progressStartedAtRef.current = null;
        setProgressFraction(0);
        setDetectionStatus('instruction_complete');

        const nextIdx = idx + 1;
        if (nextIdx >= FIXED_TOTAL_STEPS) {
          faceAllDoneRef.current = true;
          checkAndSubmit();
        } else {
          if (advanceTimerRef.current) clearTimeout(advanceTimerRef.current);
          advanceTimerRef.current = setTimeout(() => {
            submitProgress(false); // 💡 스텝 진행 시 중간 제출
            instructionIdxRef.current = nextIdx;
            setCurrentInstructionIndex(nextIdx);
            setDetectionStatus('instruction_active');
          }, 600);
        }
      }
    } else {
      if (progressStartedAtRef.current != null) { progressStartedAtRef.current = null; setProgressFraction(0); }
    }
  }

  if (!spec) return null;

  const currentInstruction = spec.instructions[currentInstructionIndex] || spec.instructions[currentInstructionIndex % spec.instructions.length];
  const currentHandInstruction = spec.hand_instructions?.[currentHandIndex] || spec.hand_instructions?.[currentHandIndex % (spec.hand_instructions?.length || 1)] || null; 
  const isCompleteFlash = detectionStatus === 'instruction_complete';

  return (
    <div className="w-full max-w-[520px] min-w-0 bg-white rounded-xl overflow-hidden mx-auto">
      <div className="flex items-center justify-between px-6 py-4 bg-gradient-to-r from-[#4a8bff] to-[#6da5ff] text-white">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 bg-white/20 rounded-lg flex items-center justify-center text-lg">😶</div>
          <div>
            <div className="font-bold text-[15px] leading-tight">안면 미션 캡챠</div>
            <div className="text-xs opacity-85 mt-0.5">카메라가 동작을 자동 감지합니다</div>
          </div>
        </div>
        <div className="flex items-center gap-2 bg-white/20 px-4 py-1.5 rounded-full">
          <span className="font-bold text-sm tabular-nums">{timeLeft}s</span>
        </div>
      </div>

      <div className="px-6 pt-5">
        <div className="flex items-center justify-between mb-3.5">
          <div className="text-xs text-[#8a96ad] font-semibold uppercase tracking-wide">진행 상태</div>
          <div className="text-sm font-bold text-[#1d2a44] tabular-nums">
            {Math.min(currentInstructionIndex + 1, FIXED_TOTAL_STEPS)}<span className="text-[#8a96ad]">/{FIXED_TOTAL_STEPS}</span> 단계
          </div>
        </div>

        <div className="relative w-full aspect-square bg-[#0a0a14] rounded-lg overflow-hidden border-2 border-[#1a1a28]">
          <video ref={videoRef} autoPlay playsInline muted className="absolute inset-0 w-full h-full object-cover" style={{ transform: 'scaleX(-1)' }} />
          <canvas ref={canvasRef} className="absolute inset-0 w-full h-full pointer-events-none" style={{ transform: 'scaleX(-1)', mixBlendMode: 'screen' }} />

          {currentInstruction && (
            <div className="absolute top-3 left-3 right-3 flex justify-center pointer-events-none">
              <div className="inline-flex items-center gap-2 bg-black/60 backdrop-blur px-4 py-2 rounded-full">
                <span className="text-xl leading-none">{ICON_FOR[currentInstruction.type] ?? '🎯'}</span>
                <span className="text-white font-bold text-sm">{currentInstruction.label}</span>
              </div>
            </div>
          )}

          {currentHandInstruction && (
            <div className="absolute top-[3.75rem] left-3 right-3 flex justify-center pointer-events-none">
              <div className={`inline-flex items-center gap-2 backdrop-blur px-4 py-2 rounded-full ${handDetected ? 'bg-emerald-600/70' : 'bg-black/60'}`}>
                <span className="text-xl leading-none">{HAND_ICON_FOR[currentHandInstruction.type] ?? '✋'}</span>
                <span className="text-white font-bold text-sm">
                  {HAND_SIDE_LABELS[currentHandInstruction.hand] ?? '손'}: {currentHandInstruction.fingers?.length ? `${currentHandInstruction.fingers.map((f) => FINGER_KO[f] ?? f).join('+')} 펴기` : currentHandInstruction.label}
                </span>
                <span className="text-white/60 text-xs">{handDetected ? '감지됨 ✓' : ''}</span>
              </div>
            </div>
          )}

          {detectionStatus === 'initializing' && (
            <div className="absolute inset-0 flex items-center justify-center bg-black/40 text-white text-sm pointer-events-none">
              <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/30 border-t-white mr-2" /> 모델 로딩 중…
            </div>
          )}
          {detectionStatus === 'no_face' && (
            <div className="absolute bottom-3.5 left-1/2 -translate-x-1/2 bg-black/70 backdrop-blur px-4 py-2 rounded-full text-xs text-white/90 pointer-events-none">📷 얼굴이 보이도록 카메라 앞에 위치해주세요</div>
          )}
          {detectionStatus === 'denied' && (
            <div className="absolute inset-0 flex flex-col items-center justify-center text-white px-6 text-center bg-black/80">
              <div className="font-bold mb-1">카메라 권한 필요</div>
              <button onClick={onRefresh} className="bg-white text-[#2563eb] px-4 py-1.5 rounded-lg text-xs font-bold mt-2">다시 시도</button>
            </div>
          )}
          {detectionStatus === 'error' && (
            <div className="absolute inset-0 flex flex-col items-center justify-center text-white px-6 text-center bg-black/80">
              <div className="font-bold mb-1">카메라 오류</div>
              <button onClick={onRefresh} className="bg-white text-[#2563eb] px-4 py-1.5 rounded-lg text-xs font-bold mt-2">다시 시도</button>
            </div>
          )}

          {isCompleteFlash && (
            <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
              <div className="bg-emerald-500/85 text-white text-5xl w-24 h-24 rounded-full flex items-center justify-center shadow-2xl animate-pulse">✓</div>
            </div>
          )}
        </div>

        <div className="mt-3.5 mb-1">
          <div className="flex items-center justify-between text-xs text-[#8a96ad] mb-1.5">
            <span>동작 유지</span>
            <span className="tabular-nums font-semibold text-[#2563eb]">{Math.round(progressFraction * 100)}%</span>
          </div>
          <div className="w-full h-2 bg-[#f0f4fb] rounded-full overflow-hidden">
            <div className="h-full bg-gradient-to-r from-[#4a8bff] to-[#7aa9ff] transition-all" style={{ width: `${progressFraction * 100}%` }} />
          </div>
        </div>

        <FishTimer remainingMs={timeLeft * 1000} totalMs={spec.time_limit_sec * 1000} className="mt-3.5" />
      </div>

      <div className="flex items-center justify-between px-6 py-5">
        <div className="flex items-center gap-2 text-[#8a96ad] text-xs"><span>🛡️</span><span>agami로 보호되는 페이지</span></div>
        <button onClick={onRefresh} className="bg-transparent border-[1.5px] border-[#e0e7f3] text-[#6b7891] px-4 py-2 rounded-xl text-sm font-semibold hover:border-[#c8dcff] hover:text-[#4a8bff] transition-colors">🔄 새로고침</button>
      </div>
    </div>
  );
}

function drawMesh(ctx, landmarks, currentType) {
  const FACE_OPTS = { color: COLOR_WHITE, lineWidth: 1.5 };
  const BLUE_OPTS = { color: COLOR_BLUE, lineWidth: 1.5 };
  const HIGHLIGHT_OPTS = { color: COLOR_YELLOW, lineWidth: 2.5 };
  const isBlinkLeft = currentType === 'blink_left', isBlinkRight = currentType === 'blink_right', isSmile = currentType === 'smile';
  const isHeadAction = currentType === 'turn_left' || currentType === 'turn_right' || currentType === 'nod';

  g.drawConnectors(ctx, landmarks, g.FACEMESH_FACE_OVAL, FACE_OPTS);
  g.drawConnectors(ctx, landmarks, g.FACEMESH_LEFT_EYE, isBlinkRight ? HIGHLIGHT_OPTS : BLUE_OPTS);
  g.drawConnectors(ctx, landmarks, g.FACEMESH_RIGHT_EYE, isBlinkLeft ? HIGHLIGHT_OPTS : BLUE_OPTS);
  g.drawConnectors(ctx, landmarks, g.FACEMESH_LIPS, isSmile ? HIGHLIGHT_OPTS : BLUE_OPTS);

  const nose = landmarks[1];
  if (nose) {
    ctx.beginPath(); ctx.arc(nose.x * ctx.canvas.width, nose.y * ctx.canvas.height, 4, 0, Math.PI * 2);
    ctx.fillStyle = isHeadAction ? COLOR_YELLOW : COLOR_BLUE; ctx.fill();
  }
}
