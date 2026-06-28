import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';

// =============================================================================
// FishTimer
// -----------------------------------------------------------------------------
// 시간이 줄면 곡선 트랙이 짧아지고 물고기가 봇 쪽으로 다가옵니다.
// 시간이 0초에 도달하는 순간, 물고기가 풍선처럼 커졌다가(Pop) 
// 방사형 파티클(Particles)과 함께 깔끔하게 터지는 애니메이션을 실행합니다.
// =============================================================================

const BOT_WIDTH_PX = 50;
const FISH_SIZE_PX = 56;
const FISH_MOUTH_OFFSET_PX = 14;        // 이미지 좌측 ~ 물고기 입까지 (px)
const CURVE_AMPLITUDE_PX = 10;          // sin 진폭
const CURVE_PERIOD_PX = 120;            // sin 주기
const CONTAINER_HEIGHT_PX = 64;         // h-16
const MID_Y = CONTAINER_HEIGHT_PX / 2;
const ROTATE_TRANSITION_MS = 200;       // 회전 lag (잔잔한 smoothing)
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

// 곡선 path 를 line segment 들로 근사
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

  // 2) 컨테이너 width 측정
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

  // 3) prop의 remainingMs 갱신 시점 동기화
  useEffect(() => {
    baseRemainingMsRef.current = remainingMs;
    baseTsRef.current = performance.now();
  }, [remainingMs]);

  // 4) totalMs 변경 (새 챌린지 시작) 시 리셋
  useEffect(() => {
    setPhase('swimming');
  }, [totalMs]);

  // 5) rAF 루프 (부드러운 애니메이션용 프레임 업데이트)
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

  // ---------------------------------------------------------------------
  // 보간된 남은 시간 계산 (정확히 0초에 도달하도록 로직 교정)
  // ---------------------------------------------------------------------
  const now = performance.now();
  const elapsedSinceBase = now - baseTsRef.current;
  const effectiveRemainingMs = reduceMotion
    ? remainingMs
    : Math.max(0, baseRemainingMsRef.current - elapsedSinceBase);

  // 진행률 (1.0 -> 0.0)
  const progress = totalMs > 0
    ? Math.max(0, Math.min(1, effectiveRemainingMs / totalMs))
    : 0;

  // 6) 정확히 남은 시간이 0초 이하가 될 때 팝(Pop) 효과 트리거
  useEffect(() => {
    if (phase !== 'swimming') return;
    if (effectiveRemainingMs <= 0) {
      setPhase('popped');
    }
  }, [effectiveRemainingMs, phase]);

  // ---------------------------------------------------------------------
  // 렌더용 파생값
  // ---------------------------------------------------------------------
  const trackSpan = Math.max(1, containerWidth - BOT_WIDTH_PX);
  const fishLeft = BOT_WIDTH_PX + trackSpan * progress; // 남은 마진 없이 progress 그대로 사용

  const onCurve = phase === 'swimming' && !reduceMotion;
  const fishTop = onCurve ? curveY(fishLeft) : MID_Y;

  const slopeAtFish = onCurve ? curveSlope(fishLeft) : 0;
  const angleDeg = Math.atan(slopeAtFish) * 180 / Math.PI;

  const mouthFromCenterPx = FISH_SIZE_PX / 2 - FISH_MOUTH_OFFSET_PX;
  const trackEndX = Math.max(BOT_WIDTH_PX, fishLeft - mouthFromCenterPx);

  const pathD = containerWidth > BOT_WIDTH_PX && trackEndX > BOT_WIDTH_PX
    ? buildCurvePath(BOT_WIDTH_PX, trackEndX, PATH_STEP_PX)
    : '';

  const fishOuterTransition = reduceMotion
    ? 'none'
    : `rotate ${ROTATE_TRANSITION_MS}ms linear`;

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
      {/* 💡 레퍼런스 영상과 동일한 효과를 위한 내부 스타일 인젝션 */}
      <style>
        {`
          @keyframes agami-pop-scale {
            0% { transform: scale(1); opacity: 1; }
            40% { transform: scale(1.35); opacity: 1; }
            100% { transform: scale(0); opacity: 0; }
          }
          @keyframes agami-particle-burst {
            0% { transform: rotate(var(--angle)) translateX(5px) scale(1.2); opacity: 1; }
            100% { transform: rotate(var(--angle)) translateX(38px) scale(0); opacity: 0; }
          }
        `}
      </style>

      {/* Bot (제자리 고정) */}
      <div
        className="absolute left-0 w-9 h-9 rounded-xl bg-gradient-to-br from-[#4a8bff] to-[#7aa9ff] flex items-center justify-center shadow-sm z-10"
        style={{
          top: '50%',
          transform: 'translateY(-50%)',
        }}
        aria-hidden
      >
        <img
          src="/bot.png"
          alt=""
          aria-hidden
          width={FISH_SIZE_PX}
          height={FISH_SIZE_PX}
          draggable={false}
          className="block w-full h-full select-none"
          style={{ objectFit: 'contain' }}
        />
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

      {/* 💡 방사형 폭발(Pop) 파티클 */}
      {phase === 'popped' && !reduceMotion && (
        <div
          className="absolute pointer-events-none z-20"
          style={{
            left: `${fishLeft}px`,
            top: `${fishTop}px`,
            width: 0,
            height: 0,
          }}
        >
          {Array.from({ length: 8 }).map((_, i) => (
            <div
              key={i}
              className="absolute w-2 h-2 rounded-full"
              style={{
                backgroundColor: '#5da2ff', // 아가미 브랜드 컬러
                marginLeft: '-4px', // 중앙 정렬 보정
                marginTop: '-4px',
                '--angle': `${i * 45}deg`,
                animation: 'agami-particle-burst 0.4s cubic-bezier(0.175, 0.885, 0.32, 1.275) forwards',
                animationDelay: '0.05s', // 물고기가 약간 커진 직후 폭발하도록 딜레이
              }}
            />
          ))}
        </div>
      )}

      {/* 물고기 본체 */}
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
            transformOrigin: 'center',
            transition: fishOuterTransition,
            pointerEvents: 'none',
            zIndex: 30,
          }}
        >
          <div
            style={{
              width: '100%',
              height: '100%',
              transformOrigin: 'center',
              // 💡 0초가 되면 풍선처럼 터지는 애니메이션 실행
              animation: phase === 'popped' && !reduceMotion ? 'agami-pop-scale 0.25s ease-out forwards' : 'none',
            }}
          >
            <img
              src="/fish.png"
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
