import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useCaptcha } from '../hooks/useCaptcha';
import CaptchaRouter from '../components/CaptchaRouter';
import { postToParent, resolveTargetOrigin } from '../embed/parentMessaging';

const ALLOWED_KINDS = ['flashlight', 'face_mission', 'context_inference'];
const CLIENT_KEY_PREFIXES = ['agami_site_', 'ck_'];

function isValidClientKeyFormat(value) {
  if (typeof value !== 'string' || value.length === 0) return false;
  return CLIENT_KEY_PREFIXES.some((p) => value.startsWith(p));
}

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
  
  const rawClientKey = searchParams.get('client_key'); 
  const clientKeyProvided = rawClientKey !== null;
  const clientKeyFormatInvalid = clientKeyProvided && !isValidClientKeyFormat(rawClientKey);
  const clientKey = clientKeyProvided ? rawClientKey : undefined;

  const { status, spec, token, error, start, submit } = useCaptcha({ kind, difficulty, clientKey });

  const themeParam = searchParams.get('theme') || 'auto';
  const [isDark, setIsDark] = useState(() => {
    if (themeParam === 'dark') return true;
    if (themeParam === 'light') return false;
    return typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches;
  });

  useEffect(() => {
    if (themeParam !== 'auto') return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = (e) => setIsDark(e.matches);
    mq.addEventListener?.('change', handler);
    return () => mq.removeEventListener?.('change', handler);
  }, [themeParam]);

  const bgColor = isDark ? 'bg-[#1a1a1b]' : 'bg-white';
  const textColor = isDark ? 'text-white' : 'text-[#1d2a44]';

  const wid = searchParams.get('wid') || undefined; 
  const isEmbedded = Boolean(wid); 
  const host = searchParams.get('host'); 
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
    const el = rootRef.current;
    const height = Math.ceil(
      isEmbedded && el ? el.getBoundingClientRect().height : document.documentElement.scrollHeight,
    );
    send({ type: 'agami-resize', height });
  }, [send, isEmbedded]);

  const startedRef = useRef(false);
  useEffect(() => {
    if (startedRef.current) return;
    if (clientKeyFormatInvalid) return; 
    if (status === 'idle') {
      startedRef.current = true;
      start();
    }
  }, [status, start, clientKeyFormatInvalid]);

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
        error: error
      });
      sentRef.current = true;
    }
  }, [status, spec, token, error, send]);

  const readySentRef = useRef(false);
  useEffect(() => {
    if (readySentRef.current) return;
    if (status === 'active' || status === 'success' || status === 'fail') {
      send({ type: 'agami-ready' });
      sendResize(); 
      readySentRef.current = true;
    }
  }, [status, send, sendResize]);

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
    sendResize(); 
    return () => {
      ro.disconnect();
      if (timer) clearTimeout(timer);
    };
  }, [sendResize]);

  const handleRetry = () => {
    sentRef.current = false;
    start();
  };

  const rootClass = isEmbedded
    ? 'flex justify-center'
    : 'min-h-screen bg-gradient-to-br from-[#f5f8ff] to-[#e8f0ff] flex items-center justify-center px-4 py-8';

  if (clientKeyFormatInvalid) {
    return (
      <div className={rootClass}>
        <div className={`mx-auto w-full max-w-[640px] rounded-3xl ${bgColor} p-8`}>
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-full bg-rose-100 text-2xl">❌</div>
            <div>
              <div className={`text-lg font-bold ${textColor}`}>잘못된 사이트 키</div>
              <div className="text-xs text-[#6b7891]">
                임베드 URL 의 client_key 형식이 올바르지 않습니다.
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div ref={rootRef} className={rootClass}>
      
      {/* [스크롤바 방지 및 다크모드 오버라이드 CSS] */}
      <style>{`
        ::-webkit-scrollbar { display: none; }
        html, body {
          margin: 0 !important;
          padding: 0 !important;
          overflow: hidden !important;
          height: 100% !important;
          background: transparent !important;
        }
        
        ${isDark ? `
          .bg-white { background-color: #1a1a1b !important; }
          .text-\\[\\#1d2a44\\] { color: #f8fafc !important; }
          .text-\\[\\#6b7891\\] { color: #94a3b8 !important; }
          .text-\\[\\#8a96ad\\] { color: #64748b !important; }
          .border-\\[\\#e0e7f3\\], .border-\\[1\\.5px\\] { border-color: #334155 !important; }
          .bg-\\[\\#f0f4fb\\] { background-color: #0f172a !important; }
          .bg-\\[\\#eef4ff\\] { background-color: rgba(74, 139, 255, 0.1) !important; }
          .border-\\[\\#c8dcff\\] { border-color: rgba(74, 139, 255, 0.2) !important; }
        ` : ''}
      `}</style>

      <div className={`w-full max-w-5xl`}>
        {/* [핵심 조치] loader.js 트리거 버튼의 로딩 효과만 보여주기 위해 React쪽 화면은 비워둠 */}
        {(status === 'idle' || status === 'loading') && (
          <div style={{ height: '0px' }}></div>
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

        {/* 팀원 연동/테스트를 위한 성공 화면 DOM */}
        {status === 'success' && (
          <div className={`mx-auto w-full max-w-[640px] rounded-3xl ${bgColor} p-8`}>
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-full bg-emerald-100 text-2xl">✅</div>
              <div>
                <div className={`text-lg font-bold ${textColor}`}>검증 성공</div>
                <div className="text-xs text-[#6b7891]">당신은 사람이군요?</div>
              </div>
            </div>
          </div>
        )}

        {/* 팀원 연동/테스트를 위한 실패 화면 DOM */}
        {status === 'fail' && (
          <div className={`mx-auto w-full max-w-[640px] rounded-3xl ${bgColor} p-8`}>
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-full bg-rose-100 text-2xl">❌</div>
              <div>
                <div className={`text-lg font-bold ${textColor}`}>검증 실패</div>
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
