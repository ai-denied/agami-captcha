import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';

// =============================================================================
// FishTimer
// -----------------------------------------------------------------------------
// 왼쪽 봇 ─ 출렁이는 sine wave 트랙 ─ 곡선 위에 올라타 헤엄치는 물고기.
// 시간이 줄면 트랙이 짧아지고, 물고기는 봇 쪽으로 다가온다.
// 봇 도달 시 물고기가 풍선처럼 펑 하고 터지는(Pop) 애니메이션 적용.
// =============================================================================

const BOT_WIDTH_PX = 50;
const FISH_SIZE_PX = 56;
const FISH_MOUTH_OFFSET_PX = 14;        // 이미지 좌측 ~ 물고기 입까지 (px)
const CURVE_AMPLITUDE_PX = 10;          // sin 진폭
const CURVE_PERIOD_PX = 120;            // sin 주기
const CONTAINER_HEIGHT_PX = 64;         // h-16
const MID_Y = CONTAINER_HEIGHT_PX / 2;

// --- 변경된 애니메이션 설정 ---
const FISH_SCALE_POP = 2.5;             // 펑 터질 때 커지는 최대 배율
const POP_DURATION_MS = 150;            // 터지는 시간 (150ms로 매우 빠르고 타격감 있게)
const ROTATE_TRANSITION_MS = 200;       // 회전 lag
const EATING_DURATION_MS = 2500;
const EATING_THRESHOLD_FALLBACK = 0.15;
const PATH_STEP_PX = 4;                 // SVG line segment 간격

// 곡선 수식
function curveY(x) {
  return MID_Y + CURVE_AMPLITUDE_PX
    * Math.sin(2 * Math.PI * (x - BOT_WIDTH_PX) / CURVE_PERIOD_PX);
}

function curveSlope(x) {
  return CURVE_AMPLITUDE_PX * (2 * Math.PI / CURVE_PERIOD_PX)
    * Math.cos(2 * Math.PI * (x - BOT_WIDTH_PX) / CURVE_PERIOD_PX);
}

function buildCurvePath(startX, endX, step) {
  if (endX <= startX) return '';
  let d = `M ${startX.toFixed(2)} ${curveY(startX).toFixed(2)}`;
  for (let x = startX + step; x < endX; x += step) {
    d += ` L ${x.toFixed(2)} ${curveY(x).toFixed(2)}`;
  }
  d += ` L ${endX.toFixed(2)} ${curveY(endX).toFixed(2)}`;
  return d;
}

export default function FishTimer({ remainingMs, totalMs, className = '' }) {
  const uid = useId().replace(/:/g, '');

  const [phase, setPhase] = useState('swimming'); // 'swimming' | 'popped'
  const [reduceMotion, setReduceMotion] = useState(false);
  const [containerWidth, setContainerWidth] = useState(0);
  const [, setTick] = useState(0);

  const containerRef = useRef(null);
  const baseRemainingMsRef = useRef(remainingMs);
  const baseTsRef = useRef(performance.now());
  const rafRef = useRef(null);

  // 1) prefers-reduced-motion
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    setReduceMotion(mq.matches);
    const handler = (e) => setReduceMotion(e.matches);
    mq.addEventListener?.('change', handler);
    return () => mq.removeEventListener?.('change', handler);
  }, []);

  // 2) 컨테이너 width
  useLayoutEffect(() => {
    if (containerRef.current) setContainerWidth(containerRef.current.offsetWidth);
  }, []);
  useEffect(() => {
    if (!containerRef.current) return;
    const ro = new ResizeObserver((entries) => {
      setContainerWidth(entries[0].contentRect.width);
    });
    ro.observe(containerRef.current);
    return () => ro.disconnect();
  }, []);

  // 3) prop remainingMs 갱신
  useEffect(() => {
    baseRemainingMsRef.current = remainingMs;
    baseTsRef.current = performance.now();
  }, [remainingMs]);

  // 4) totalMs 변경 시 리셋
  useEffect(() => {
    setPhase('swimming');
  }, [totalMs]);

  // 5) rAF 루프
  useEffect(() => {
    if (reduceMotion || phase !== 'swimming') return;
    const loop = () => {
      setTick((t) => (t + 1) % 1e9);
      rafRef.current = requestAnimationFrame(loop);
    };
    rafRef.current = requestAnimationFrame(loop);
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    };
  }, [phase, reduceMotion]);

  const now = performance.now();
  const elapsedSinceBase = now - baseTsRef.current;
  const effectiveRemainingMs = reduceMotion
    ? remainingMs
    : Math.max(0, baseRemainingMsRef.current - elapsedSinceBase);

  const progress = totalMs > 0
    ? Math.max(0, Math.min(1, effectiveRemainingMs / totalMs))
    : 0;

  const eatingThreshold = totalMs > 0
    ? Math.min(EATING_DURATION_MS / totalMs, 0.5)
    : EATING_THRESHOLD_FALLBACK;

  const visualProgress = progress > eatingThreshold
    ? (progress - eatingThreshold) / (1 - eatingThreshold)
    : 0;

  // 6) 봇에 도달 시 터지는(Pop) 페이즈로 전환
  useEffect(() => {
    if (phase !== 'swimming') return;
    if (progress <= eatingThreshold) {
      setPhase('popped');
    }
  }, [progress, phase, eatingThreshold]);

  // ---------------------------------------------------------------------
  // 렌더용 파생값
  // ---------------------------------------------------------------------
  const trackSpan = Math.max(1, containerWidth - BOT_WIDTH_PX);
  const fishLeft = BOT_WIDTH_PX + trackSpan * visualProgress;

  const onCurve = phase === 'swimming' && !reduceMotion;
  const fishTop = onCurve ? curveY(fishLeft) : MID_Y;

  const slopeAtFish = onCurve ? curveSlope(fishLeft) : 0;
  const angleDeg = Math.atan(slopeAtFish) * 180 / Math.PI;

  const mouthFromCenterPx = FISH_SIZE_PX / 2 - FISH_MOUTH_OFFSET_PX;
  const trackEndX = Math.max(BOT_WIDTH_PX, fishLeft - mouthFromCenterPx);

  const pathD = containerWidth > BOT_WIDTH_PX && trackEndX > BOT_WIDTH_PX
    ? buildCurvePath(BOT_WIDTH_PX, trackEndX, PATH_STEP_PX)
    : '';

  // 💡 [수정] 봇은 더 이상 빙글빙글 돌거나 사라지지 않고 제자리에 유지됩니다.
  const botTransform = 'translateY(-50%)';
  const botOpacity = 1;
  const botTransition = 'none';

  // 💡 [수정] 물고기가 닿으면 2.5배 커지면서 동시에 투명도 0으로 펑 터지는 효과
  const isPopped = phase === 'popped';
  const fishScale = isPopped ? FISH_SCALE_POP : 1.0;
  const fishOpacity = isPopped ? 0 : 1;
  
  // scale과 opacity에 짧은 시간을 주어 풍선이 터지는 듯한 타격감을 줍니다.
  const fishOuterTransition = reduceMotion
    ? 'none'
    : `rotate ${ROTATE_TRANSITION_MS}ms linear, scale ${POP_DURATION_MS}ms cubic-bezier(0.175, 0.885, 0.32, 1.275), opacity ${POP_DURATION_MS}ms ease-out`;

  return (
    <div
      ref={containerRef}
      className={`relative h-16 overflow-visible ${className}`}
      role="progressbar"
      aria-label="남은 시간"
      aria-valuemin={0}
      aria-valuemax={totalMs}
      aria-valuenow={Math.max(0, effectiveRemainingMs)}
    >
      {/* Bot — 가만히 고정 */}
      <div
        className="absolute left-0 w-9 h-9 rounded-xl bg-gradient-to-br from-[#4a8bff] to-[#7aa9ff] flex items-center justify-center shadow-sm z-10"
        style={{
          top: '50%',
          transform: botTransform,
          transformOrigin: 'center',
          opacity: botOpacity,
          transition: botTransition,
        }}
        aria-hidden
      >
        <svg
          width="20"
          height="20"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="text-white"
        >
          <path d="M12 8V4H8" />
          <rect width="16" height="12" x="4" y="8" rx="2" />
          <path d="M2 14h2" />
          <path d="M20 14h2" />
          <path d="M15 13v2" />
          <path d="M9 13v2" />
        </svg>
      </div>

      {/* SVG 곡선 트랙 */}
      <svg
        className="absolute inset-0 w-full h-full overflow-visible pointer-events-none"
        aria-hidden
      >
        <defs>
          <linearGradient
            id={`trk-${uid}`}
            gradientUnits="userSpaceOnUse"
            x1={BOT_WIDTH_PX}
            x2={Math.max(BOT_WIDTH_PX + 1, containerWidth)}
            y1={MID_Y}
            y2={MID_Y}
          >
            <stop offset="0%" stopColor="#4a8bff" />
            <stop offset="100%" stopColor="#7aa9ff" />
          </linearGradient>
        </defs>
        {pathD && (
          <path
            d={pathD}
            stroke={`url(#trk-${uid})`}
            strokeWidth="6"
            fill="none"
            strokeLinecap="round"
          />
        )}
      </svg>

      {/* 물고기 — 터지는 애니메이션 */}
      {containerWidth > 0 && (
        <div
          style={{
            position: 'absolute',
            left: `${fishLeft}px`,
            top: `${fishTop}px`,
            width: FISH_SIZE_PX,
            height: FISH_SIZE_PX,
            translate: '-50% -50%',
            rotate: `${angleDeg}deg`,
            scale: String(fishScale),
            opacity: fishOpacity, // 💡 터지면서 투명해짐
            transformOrigin: 'center',
            transition: fishOuterTransition,
            pointerEvents: 'none',
          }}
        >
          <div
            style={{
              width: '100%',
              height: '100%',
              transformOrigin: 'center',
            }}
          >
            <img
              src={`${import.meta.env.BASE_URL}timer-fish.png`} // 물고기 이미지 경로 확인 필요
              alt=""
              aria-hidden
              width={FISH_SIZE_PX}
              height={FISH_SIZE_PX}
              draggable={false}
              className="block w-full h-full select-none"
              style={{ objectFit: 'contain' }}
            />
          </div>
        </div>
      )}
    </div>
  );
}
