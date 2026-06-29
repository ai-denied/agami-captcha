import { useEffect, useRef, useState } from 'react';

import FishTimer from './FishTimer';

import { API_BASE_URL } from '../api/captchaApi';



// =============================================================================

// 감정 맥락 추론 캡챠 위젯 (N문제 시퀀스 인터랙션)

// =============================================================================



const EMOTION_KO = {

  happiness: '행복',

  calm: '평온',

  anticipation: '기대',

  affection: '애정',

  anger: '분노',

  fear: '두려움',

  sadness: '슬픔',

  disconnection: '지침',

  suffering: '고통',

  aversion: '거부감',

  embarrassment: '당혹',

  confidence: '자신감',

  confusion: '혼란',

  yearning: '그리움',

};



const EMOTION_ICON = {

  happiness: '😊',

  calm: '😌',

  anticipation: '🤔',

  affection: '🥰',

  anger: '😠',

  fear: '😨',

  sadness: '😢',

  disconnection: '😶',

  suffering: '😣',

  aversion: '🤢',

  embarrassment: '😳',

  confidence: '😎',

  confusion: '😕',

  yearning: '🥺',

};



export default function ImageGridCaptcha({ spec, onSubmit, onRefresh, status, error, embedded = false }) {

  const [timeLeft, setTimeLeft] = useState(spec?.time_limit_sec ?? 30);

  const [step, setStep] = useState(0);

  const [answers, setAnswers] = useState([]);

  const [selected, setSelected] = useState(null);

  const [submitting, setSubmitting] = useState(false);

  const [imgLoaded, setImgLoaded] = useState(false);

  const startedAtRef = useRef(Date.now());



  useEffect(() => {

    if (!spec) return;

    setTimeLeft(spec.time_limit_sec);

    setStep(0);

    setAnswers([]);

    setSelected(null);

    setSubmitting(false);

    setImgLoaded(false);

    startedAtRef.current = Date.now();

  }, [spec]);



  useEffect(() => {

    setImgLoaded(false);

  }, [step]);



  useEffect(() => {

    if (!spec) return;

    const tick = setInterval(() => {

      setTimeLeft((t) => {

        if (t <= 1) { clearInterval(tick); return 0; }

        return t - 1;

      });

    }, 1000);

    return () => clearInterval(tick);

  }, [spec]);



  if (!spec) return null;



  const total = spec.total_count ?? (spec.questions?.length ?? 0);

  const currentQ = spec.questions?.[step];

  const isLastStep = step >= total - 1;

  const canAdvance = selected != null && !submitting;



  const handlePick = (emotion) => {

    if (submitting) return;

    setSelected(emotion);

  };



  const handleNext = () => {

    if (!canAdvance) return;

    if (isLastStep) {

      setSubmitting(true);

      onSubmit({

        submitted_answers: [...answers, selected],

        behavioral_data: {

          time_taken_ms: Date.now() - startedAtRef.current,

        },

      });

    } else {

      setAnswers((prev) => [...prev, selected]);

      setStep((s) => s + 1);

      setSelected(null);

    }

  };



  const stepPct = ((step + 1) / total) * 100;



  return (

    // 💡 핵심 조치: max-w-[480px]를 520px로 확장하여 iframe 화면에 꽉 차도록 여백 제거

    <div className="w-full max-w-[520px] min-w-0 bg-white rounded-xl overflow-hidden mx-auto">

      {/* Header */}

      <div className="flex items-center justify-between px-6 py-4 bg-gradient-to-r from-[#4a8bff] to-[#6da5ff] text-white">

        <div className="flex items-center gap-3">

          <div className="w-9 h-9 bg-white/20 rounded-lg flex items-center justify-center text-lg">

            🧠

          </div>

          <div>

            <div className="font-bold text-[15px] leading-tight">감정 맥락 추론 캡챠</div>

            <div className="text-xs opacity-85 mt-0.5">사진을 보고 감정을 골라주세요</div>

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

        {/* 단계 표시 */}

        <div className="flex items-center justify-between mb-2.5">

          <div className="text-xs text-[#8a96ad] font-semibold uppercase tracking-wide">

            진행 상태

          </div>

          <div className="text-sm font-bold text-[#1d2a44] tabular-nums">

            문제 {step + 1}<span className="text-[#8a96ad]"> / {total}</span>

          </div>

        </div>

        <div className="mb-4 w-full h-1.5 bg-[#f0f4fb] rounded-full overflow-hidden">

          <div

            className="h-full bg-gradient-to-r from-[#4a8bff] to-[#7aa9ff] rounded-full transition-all duration-300"

            style={{ width: `${stepPct}%` }}

          />

        </div>



        {/* 현재 문제 이미지 */}

        <div className="relative w-full bg-[#f0f4fb] rounded-xl overflow-hidden border-2 border-[#e0e7f3] flex items-center justify-center" style={{ minHeight: '160px' }}>

          <img

            key={step}

            src={`${API_BASE_URL}${currentQ?.image_url ?? ''}`}

            alt={`감정 추론 문제 ${step + 1}`}

            onLoad={() => setImgLoaded(true)}

            onError={() => setImgLoaded(true)}

            className={

              'block max-h-[40vh] w-auto max-w-full object-contain transition-opacity duration-300 ' +

              (imgLoaded ? 'opacity-100' : 'opacity-0')

            }

            draggable={false}

          />

          {!imgLoaded && (

            <div className="absolute inset-0 flex items-center justify-center text-[#8a96ad]">

              <span className="h-5 w-5 animate-spin rounded-full border-2 border-[#e0e7f3] border-t-[#4a8bff]" />

            </div>

          )}

        </div>



        {/* 질문 */}

        <div className="mt-4 mb-3">

          <span className="text-xs text-[#8a96ad] font-semibold uppercase tracking-wide mr-2">Q.</span>

          <span className="text-[#1d2a44] font-bold text-base">

            이 사진에서 느껴지는 감정은?

          </span>

        </div>



        {/* 2×2 선택지 */}

        <div className="grid grid-cols-2 gap-2.5">

          {(currentQ?.choices ?? []).map((emotion) => {

            const isPicked = selected === emotion;

            const isOtherPicked = selected != null && !isPicked;

            return (

              <button

                key={emotion}

                type="button"

                disabled={submitting}

                onClick={() => handlePick(emotion)}

                className={

                  'flex items-center justify-center gap-2 px-4 py-3 rounded-xl text-sm font-bold transition border-[1.5px] ' +

                  (isPicked

                    ? 'bg-[#4a8bff] border-[#4a8bff] text-white shadow-[0_8px_24px_rgba(74,139,255,0.35)]'

                    : isOtherPicked

                    ? 'bg-[#eef4ff] border-[#c8dcff] text-[#2563eb] opacity-50 cursor-pointer'

                    : 'bg-[#eef4ff] border-[#c8dcff] text-[#2563eb] hover:bg-[#dceaff] hover:border-[#4a8bff] cursor-pointer')

                }

              >

                <span className="text-base leading-none">{EMOTION_ICON[emotion] ?? '🎯'}</span>

                <span>{EMOTION_KO[emotion] ?? emotion}</span>

              </button>

            );

          })}

        </div>



        {/* 다음 / 제출 버튼 */}

        <button

          type="button"

          onClick={handleNext}

          disabled={!canAdvance}

          className={

            'mt-4 w-full px-4 py-3 rounded-xl text-sm font-bold transition-transform ' +

            (canAdvance

              ? 'bg-gradient-to-r from-[#4a8bff] to-[#6da5ff] text-white shadow-[0_8px_24px_rgba(74,139,255,0.35)] hover:-translate-y-0.5'

              : 'bg-[#eef4ff] text-[#8a96ad] cursor-not-allowed')

          }

        >

          {submitting

            ? '제출 중…'

            : isLastStep

            ? '제출하기'

            : '다음 →'}

        </button>



        {/* 전체 남은 시간 */}

        <FishTimer

          remainingMs={timeLeft * 1000}

          totalMs={spec.time_limit_sec * 1000}

          className="mt-4"

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