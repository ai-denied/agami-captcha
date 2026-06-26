import { useCallback, useEffect, useRef, useState } from 'react';
import { issueChallenge, submitAnswer } from '../api/captchaApi';

// =============================================================================
// 캡챠 상태 머신 훅
// status: idle → loading → active → (success | fail)
// active 동안 spec.time_limit_sec 카운트다운, 0 이 되면 자동 fail.
// =============================================================================

export function useCaptcha({ kind = 'flashlight', difficulty = null, clientKey } = {}) {
  const [status, setStatus] = useState('idle'); // idle|loading|active|success|fail
  const [spec, setSpec] = useState(null);
  const [token, setToken] = useState(null);
  const [error, setError] = useState(null);
  const [remainingSec, setRemainingSec] = useState(0);

  const startedAtRef = useRef(null);

  // --- 통합 실패 핸들러 (연속 5회 실패 시 30분 차단 기능) ---
  const handleFail = useCallback((err) => {
    const BAN_MINUTES = 30;
    const now = Date.now();
    const fails = parseInt(localStorage.getItem('agami_fail_count') || '0', 10) + 1;

    if (fails >= 5) {
      // 5회 실패 도달 시 현재 시간 + 30분으로 밴 해제 시간 기록
      localStorage.setItem('agami_ban_until', (now + BAN_MINUTES * 60 * 1000).toString());
      setError({ code: 'banned', message: '연속 5회 실패로 30분간 이용이 차단되었습니다.' });
    } else {
      localStorage.setItem('agami_fail_count', fails.toString());
      setError(err);
    }
    setStatus('fail');
  }, []);

  const start = useCallback(async () => {
    // 시작 전: 밴 타임이 남아있는지 확인
    const banUntil = localStorage.getItem('agami_ban_until');
    if (banUntil) {
      if (Date.now() < parseInt(banUntil, 10)) {
        const remainMins = Math.ceil((parseInt(banUntil, 10) - Date.now()) / 60000);
        setError({ code: 'banned', message: `차단됨: ${remainMins}분 후 다시 시도해주세요.` });
        setStatus('fail');
        return;
      } else {
        // 밴 기간이 종료되었다면 카운트 초기화
        localStorage.removeItem('agami_ban_until');
        localStorage.removeItem('agami_fail_count');
      }
    }

    setStatus('loading');
    setError(null);
    setSpec(null);
    setToken(null);

    const res = await issueChallenge(kind, difficulty, clientKey);
    if (!res.ok) {
      handleFail(res.error);
      return;
    }
    const s = res.data;
    setSpec(s);
    setRemainingSec(s.time_limit_sec);
    startedAtRef.current = Date.now();
    setStatus('active');
  }, [kind, difficulty, clientKey, handleFail]);

  const reset = useCallback(() => {
    setStatus('idle');
    setSpec(null);
    setToken(null);
    setError(null);
    setRemainingSec(0);
    startedAtRef.current = null;
  }, []);

  const submit = useCallback(
    async (payload) => {
      if (!spec || status !== 'active') return;

      const timeTakenMs = startedAtRef.current
        ? Date.now() - startedAtRef.current
        : null;

      const enriched = {
        ...(payload ?? {}),
        behavioral_data: {
          ...(payload?.behavioral_data ?? {}),
          time_taken_ms: payload?.behavioral_data?.time_taken_ms ?? timeTakenMs,
        },
      };

      const res = await submitAnswer(spec.challenge_id, enriched, clientKey);
      if (res.ok) {
        if (res.data?.decision === 'block') {
          handleFail({ code: 'verification_failed', message: '행동 분석 결과 사람으로 인증되지 않았습니다.' });
        } else {
          // 정답을 맞추면 밴 카운터 리셋
          localStorage.removeItem('agami_fail_count');
          setToken(res.data.captcha_token);
          setStatus('success');
        }
      } else {
        handleFail(res.error);
      }
    },
    [spec, status, clientKey, handleFail],
  );

  // --- 타이머 ---
  useEffect(() => {
    if (status !== 'active' || !spec) return;
    const tick = setInterval(() => {
      setRemainingSec((prev) => {
        if (prev <= 1) {
          clearInterval(tick);
          handleFail({ code: 'timeout', message: '시간 초과' });
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
    return () => clearInterval(tick);
  }, [status, spec, handleFail]);

  // --- 급격한 화면 비율 변경 감지 (개발자 도구 오픈 방어) ---
  useEffect(() => {
    if (status !== 'active') return;

    let lastWidth = window.innerWidth;
    let lastHeight = window.innerHeight;

    const onResize = () => {
      const nw = window.innerWidth;
      const nh = window.innerHeight;
      
      // 창의 가로 또는 세로 크기가 20% 이상 급격하게 변화했는지 감지
      const ratioW = Math.abs(nw - lastWidth) / lastWidth;
      const ratioH = Math.abs(nh - lastHeight) / lastHeight;

      if (ratioW > 0.2 || ratioH > 0.2) {
        handleFail({ code: 'abnormal_resize', message: '비정상적인 화면 변경(개발자 도구 등)이 감지되어 취소되었습니다.' });
      }
      lastWidth = nw;
      lastHeight = nh;
    };

    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [status, handleFail]);

  return {
    status,
    spec,
    token,
    error,
    remainingSec,
    start,
    submit,
    reset,
  };
}
