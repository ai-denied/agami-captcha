import { useCallback, useEffect, useRef, useState } from 'react';
import { issueChallenge, submitAnswer } from '../api/captchaApi';

export function useCaptcha({ kind = 'flashlight', difficulty = null, clientKey } = {}) {
  const [status, setStatus] = useState('idle'); 
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
      localStorage.setItem('agami_ban_until', (now + BAN_MINUTES * 60 * 1000).toString());
      setError({ code: 'banned', message: '연속 5회 실패로 30분간 이용이 차단되었습니다.' });
    } else {
      localStorage.setItem('agami_fail_count', fails.toString());
      setError(err);
    }
    setStatus('fail');
  }, []);

  const start = useCallback(async () => {
    const banUntil = localStorage.getItem('agami_ban_until');
    if (banUntil) {
      if (Date.now() < parseInt(banUntil, 10)) {
        const remainMins = Math.ceil((parseInt(banUntil, 10) - Date.now()) / 60000);
        setError({ code: 'banned', message: `차단됨: ${remainMins}분 후 다시 시도해주세요.` });
        setStatus('fail');
        return; 
      } else {
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

  return { status, spec, token, error, remainingSec, start, submit, reset };
}
