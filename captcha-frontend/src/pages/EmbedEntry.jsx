import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useCaptcha } from '../hooks/useCaptcha';
import CaptchaRouter from '../components/CaptchaRouter';
import { postToParent, resolveTargetOrigin } from '../embed/parentMessaging';

// =============================================================================
// /embed 라우트 — iframe 임베드 전용 진입점
//   URL 쿼리:
//     kind        flashlight (기본) | face_mission | context_inference
//     difficulty  easy (기본) | normal | medium | hard
//                 ('normal' 은 백엔드 enum 'medium' 으로 자동 매핑)
//
//   동작:
//     1) 마운트 즉시 캡챠 발급 + 시작 (Home/선택 화면 안 거침)
//     2) status success/fail 전환 시 agami-result 발신 (기존 필드 + wid 추가)
//        payload = { type:'agami-result', success, challengeId, challengeType, captchaToken, wid? }
//     3) (loader 임베드 시) agami-ready 1회 + agami-resize(height) 발신.
//   URL 쿼리 추가: wid(부모가 부여한 위젯 id, 모든 메시지에 echo), host(부모 origin → targetOrigin)
//   targetOrigin: host 유효 시 host, 부재 시 '*'(직접-iframe 경로 호환).
//
//   부모 페이지 수신 예:
//     window.addEventListener('message', e => {
//       if (e.data?.type === 'agami-result') { /* e.data.success / e.data.captchaToken */ }
//     });
// =============================================================================

const ALLOWED_KINDS = ['flashlight', 'face_mission', 'context_inference'];

// client_key(site_key) 형식 검증 — 접두어/비어있음 수준까지만.
// 실제 키 유효성은 백엔드 verify_client_key 에 맡긴다(중복 검증 금지).
//   - 회원 발급 키: agami_site_...
//   - 개발/테스트 폴백 키: ck_...
const CLIENT_KEY_PREFIXES = ['agami_site_', 'ck_'];
function isValidClientKeyFormat(value) {
  if (typeof value !== 'string' || value.length === 0) return false;
  return CLIENT_KEY_PREFIXES.some((p) => value.startsWith(p));
}
// 'normal' 은 사용자 친화 별칭. 백엔드는 medium 만 인식.
const DIFFICULTY_MAP = {
  easy: 'easy',
  normal: 'medium',
  medium: 'medium',
  hard: 'hard',
};

export default function EmbedEntry() {
  const [searchParams] = useSearchParams();
  const rawKind = (searchParams.get('kind') ?? 'flashlight').toLowerCase();
  const kind = ALLOWED_KINDS.includes(rawKind) ? rawKind : 'flashlight';
  const rawDiff = (searchParams.get('difficulty') ?? 'easy').toLowerCase();
  const difficulty = DIFFICULTY_MAP[rawDiff] ?? 'easy';

  // client_key 주입:
  //   - 파라미터가 '아예 없으면'(null) 에러 없이 .env 폴백 → useCaptcha 에 undefined 전달.
  //   - 파라미터가 '존재하는데' 형식이 틀리면(빈 문자열/접두어 불일치) 명확한 에러 표시.
  //   - 우선순위: URL client_key > VITE_CAPTCHA_CLIENT_KEY > 'ck_test' (captchaApi.buildHeaders).
  const rawClientKey = searchParams.get('client_key'); // 없으면 null
  const clientKeyProvided = rawClientKey !== null;
  const clientKeyFormatInvalid = clientKeyProvided && !isValidClientKeyFormat(rawClientKey);
  const clientKey = clientKeyProvided ? rawClientKey : undefined;

  const { status, spec, token, error, start, submit } = useCaptcha({ kind, difficulty, clientKey });

  // --- 부모(loader) 통신 파라미터 (additive). 둘 다 없으면 직접-iframe 경로와 동일하게 동작.
  const wid = searchParams.get('wid') || undefined; // 부모가 부여한 위젯 id (모든 메시지에 echo)
  const isEmbedded = Boolean(wid); // loader 경유 임베드 여부 — 레이아웃/높이측정 분기에만 사용(캡차 로직 불변)
  const host = searchParams.get('host'); // 부모 origin → targetOrigin
  const targetOrigin = useMemo(() => resolveTargetOrigin(host), [host]);
  const send = useCallback(
    (payload) => {
      if (typeof window === 'undefined') return;
      postToParent(window.parent, payload, { wid, targetOrigin });
    },
    [wid, targetOrigin],
  );
  const rootRef = useRef(null);
  const sendResize = useCallback(() => {
    if (typeof document === 'undefined') return;
    // 임베드(wid): 루트 콘텐츠 높이로 측정 → iframe 이 콘텐츠에 맞게 줄어듦(파란 여백 제거).
    //   documentElement.scrollHeight 는 viewport(=iframe)보다 작아질 수 없어 축소가 안 되므로 사용 안 함.
    // 직접 경로(wid 없음): 기존과 100% 동일하게 documentElement.scrollHeight.
    const el = rootRef.current;
    const height = Math.ceil(
      isEmbedded && el ? el.getBoundingClientRect().height : document.documentElement.scrollHeight,
    );
    send({ type: 'agami-resize', height });
  }, [send, isEmbedded]);

  // 첫 마운트 시 자동 시작 — idle → loading → active 자동 전환
  const startedRef = useRef(false);
  useEffect(() => {
    if (startedRef.current) return;
    if (clientKeyFormatInvalid) return; // 잘못된 키면 챌린지 발급 자체를 막는다.
    if (status === 'idle') {
      startedRef.current = true;
      start();
    }
  }, [status, start, clientKeyFormatInvalid]);

  // status 종료 시 단 한 번 agami-result 발신 (기존 필드 유지 + wid 추가).
  const sentRef = useRef(false);
  useEffect(() => {
    if (sentRef.current) return;
    if (status === 'success') {
      send({
        type: 'agami-result',
        success: true,
        challengeId: spec?.challenge_id ?? null,
        challengeType: spec?.kind ?? null,
        captchaToken: token ?? null,
      });
      sentRef.current = true;
    } else if (status === 'fail') {
      send({
        type: 'agami-result',
        success: false,
        challengeId: spec?.challenge_id ?? null,
        challengeType: spec?.kind ?? null,
        captchaToken: null,
      });
      sentRef.current = true;
    }
  }, [status, spec, token, send]);

  // agami-ready: 위젯이 상호작용 가능/표시 완료된 첫 시점 1회 (loader 스피너 제거 트리거).
  //   "첫 챌린지 렌더 완료(스피너 내릴 시점)" = status 가 loading 을 벗어나는 순간으로 정의.
  const readySentRef = useRef(false);
  useEffect(() => {
    if (readySentRef.current) return;
    if (status === 'active' || status === 'success' || status === 'fail') {
      send({ type: 'agami-ready' });
      sendResize(); // ready 직후 초기 높이 동기화
      readySentRef.current = true;
    }
  }, [status, send, sendResize]);

  // agami-resize: 루트 엘리먼트 높이 변화를 100ms throttle 로 부모에 통지.
  useEffect(() => {
    const el = rootRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return undefined;
    let timer = null;
    const onResize = () => {
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        sendResize();
      }, 100);
    };
    const ro = new ResizeObserver(onResize);
    ro.observe(el);
    sendResize(); // 초기 1회
    return () => {
      ro.disconnect();
      if (timer) clearTimeout(timer);
    };
  }, [sendResize]);

  // 재시도: postMessage 한 번 발신 후에는 부모가 iframe reload 로 처리하는 것이 원칙.
  // 다만 UX 차원의 자체 재시도 버튼 1회만 허용 — sent flag 해제 후 start().
  const handleRetry = () => {
    sentRef.current = false;
    start();
  };

  // 루트 레이아웃: 임베드(wid)일 때만 100vh/파란 그라데이션/수직중앙 제거 → 콘텐츠 높이·투명(여백 제거).
  //   직접 iframe(wid 없음)은 기존 className 문자열 그대로 → 1px도 안 바뀜.
  const rootClass = isEmbedded
    ? 'flex justify-center'
    : 'min-h-screen bg-gradient-to-br from-[#f5f8ff] to-[#e8f0ff] flex items-center justify-center px-4 py-8';
  // 카드 경계: 임베드(wid) 시에만 큰 그림자 대신 옅은 회색 테두리 + shadow-sm(밝은 배경에서 카드 구분).
  //   직접 경로는 기존 큰 그림자 문자열 그대로 → 카드 모양 불변.
  const cardEdge = isEmbedded
    ? 'border border-gray-200 shadow-sm'
    : 'shadow-[0_20px_60px_rgba(70,130,255,0.15)]';

  // client_key 파라미터가 존재하지만 형식이 틀린 경우: 챌린지 발급 없이 명확한 에러만 표시.
  if (clientKeyFormatInvalid) {
    return (
      <div className={rootClass}>
        <div className={`mx-auto w-full max-w-[640px] rounded-3xl bg-white p-8 ${cardEdge}`}>
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-full bg-rose-100 text-2xl">
              ❌
            </div>
            <div>
              <div className="text-lg font-bold text-[#1d2a44]">잘못된 사이트 키</div>
              <div className="text-xs text-[#6b7891]">
                임베드 URL 의 client_key 형식이 올바르지 않습니다.
                <span className="text-rose-500 ml-1">(invalid_client_key_format)</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div ref={rootRef} className={rootClass}>
      <div className="w-full max-w-5xl">
        {(status === 'idle' || status === 'loading') && (
          <div className={`mx-auto flex h-48 w-full max-w-[640px] items-center justify-center rounded-3xl bg-white ${cardEdge}`}>
            <div className="flex items-center gap-3 text-[#6b7891]">
              <span className="h-4 w-4 animate-spin rounded-full border-2 border-[#e0e7f3] border-t-[#4a8bff]" />
              <span className="text-sm font-medium">챌린지를 발급받는 중…</span>
            </div>
          </div>
        )}

        {status === 'active' && spec && (
          <CaptchaRouter
            kind={kind}
            spec={spec}
            status={status}
            error={error}
            onSubmit={submit}
            onRefresh={start}
            embedded={isEmbedded}
          />
        )}

        {status === 'success' && (
          <div className={`mx-auto w-full max-w-[640px] rounded-3xl bg-white p-8 ${cardEdge}`}>
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-full bg-emerald-100 text-2xl">
                ✅
              </div>
              <div>
                <div className="text-lg font-bold text-[#1d2a44]">검증 성공</div>
                <div className="text-xs text-[#6b7891]">
                  당신은 사람이군요?
                </div>
              </div>
            </div>
          </div>
        )}

        {status === 'fail' && (
          <div className={`mx-auto w-full max-w-[640px] rounded-3xl bg-white p-8 ${cardEdge}`}>
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-full bg-rose-100 text-2xl">
                ❌
              </div>
              <div>
                <div className="text-lg font-bold text-[#1d2a44]">검증 실패</div>
                <div className="text-xs text-[#6b7891]">
                  {error?.message || '알 수 없는 오류'}
                  {error?.code ? <span className="text-rose-500 ml-1">({error.code})</span> : null}
                </div>
              </div>
            </div>
            <div className="mt-5">
              <button
                onClick={handleRetry}
                className="rounded-xl bg-gradient-to-r from-[#4a8bff] to-[#6da5ff] px-4 py-2 text-sm font-bold text-white shadow-[0_8px_24px_rgba(74,139,255,0.35)] hover:-translate-y-0.5 transition-transform"
              >
                다시 시도
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
