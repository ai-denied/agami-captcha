"""
Hand Mission 서버측 손동작 기하 검증 (A3)
==========================================
``face_evidence.py`` 와 평행한 구조. face_mission 챌린지의 ``face_behavioral_data``
안에 병렬로 실리는 ``hand_evidence`` (MediaPipe Hands 21점 랜드마크 시계열)를 받아
손동작(open_hand / fist / pinch)이 실제로 일어났는지 검증한다.

좌표 컨벤션: ``landmarks`` 는 ``dict[str, [x, y]]`` (정규화 0~1). 손 크기로 정규화해
캡처 거리/해상도에 둔감하게 만든다.

검증 강도: face 의 transition 검증(도달+복귀)보다 가벼운 **존재 검증** —
window 안에 임계를 만족하는 프레임이 1개라도 있으면 통과(명세 [3]).

모든 검증은 **fail-closed**: 파싱 실패 / 증거 부족 / 식 산출 불가 → False.
단, hand 를 요구하지 않는 챌린지(expected_hand_instruction_types 가 빔)는
하위호환을 위해 True 를 반환한다(기존 face-only 챌린지 영향 0).
"""

from __future__ import annotations

import logging
import math
from typing import TYPE_CHECKING

from pydantic import BaseModel, ConfigDict, Field

if TYPE_CHECKING:
    from app.captcha.challenge_types import FaceChallengeAnswer

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# MediaPipe Hands 21점 랜드마크 인덱스 (명세 [3] 그대로)
# ---------------------------------------------------------------------------
WRIST = 0
MIDDLE_FINGER_MCP = 9
INDEX_FINGER_TIP = 8
PINKY_TIP = 20
THUMB_TIP = 4

# 제스처 임계 — hand_size 로 정규화된 비율. ★ 위젯 handDetection.js 와 동일(단일 출처).
# 로컬 실측 캘리브레이션: 주먹 spread 0.49~0.68 / pinch 0.30~0.39, 핀치 spread>1.2 /
# pinch 0.10~0.18, 펴기 spread 0.89~1.32 / pinch 0.47~1.05. fist·pinch 가 spread 에서
# 겹쳐 우선순위(pinch→open→fist)로 분리한다. 조정 시 handDetection.js 도 함께 바꾼다.
OPEN_TH = 0.80    # spread > OPEN_TH → 손 폄
FIST_TH = 0.75    # spread < FIST_TH (그리고 pinch 아님) → 주먹
PINCH_TH = 0.25   # pinch_ratio < PINCH_TH → 엄지-검지 붙음

# 유효(식 산출 가능) 프레임이 이보다 적으면 검증 실패 (face_evidence 와 동일 floor).
MIN_VALID_FRAMES = 5


# ---------------------------------------------------------------------------
# 증거 페이로드 스키마 (face_behavioral_data.hand_evidence 하위 구조)
# ---------------------------------------------------------------------------

class HandEvidenceFrame(BaseModel):
    model_config = ConfigDict(extra="ignore")
    t: int
    landmarks: dict[str, list[float]]


class HandEvidenceInstruction(BaseModel):
    model_config = ConfigDict(extra="ignore")
    type: str
    completed_at_t: int | None = None
    hand: str | None = None  # A3 좌우: 위젯이 관측한 사용자 손 ("left"|"right"|None)
    frames: list[HandEvidenceFrame] = Field(default_factory=list)


class HandEvidenceInner(BaseModel):
    model_config = ConfigDict(extra="ignore")
    instructions: list[HandEvidenceInstruction] = Field(default_factory=list)


class _HandEvidenceEnvelope(BaseModel):
    """face_behavioral_data 에서 hand_evidence 슬롯만 추출하기 위한 래퍼.
    위젯은 hand 미구현 단계에서 ``hand_evidence: null`` 을 보내므로 None 허용."""
    model_config = ConfigDict(extra="ignore")
    hand_evidence: HandEvidenceInner | None = None


# ---------------------------------------------------------------------------
# 기하 헬퍼 — hand_size 정규화 (명세 [3] 그대로)
# ---------------------------------------------------------------------------

Point = tuple[float, float]


def _pt(lm: dict[str, list[float]], idx: int) -> Point | None:
    """landmarks 에서 idx 의 (x, y). 없거나 [x,y] 형식이 아니면 None."""
    p = lm.get(str(idx))
    if not isinstance(p, (list, tuple)) or len(p) < 2:
        return None
    return float(p[0]), float(p[1])


def _dist(a: Point, b: Point) -> float:
    return math.hypot(a[0] - b[0], a[1] - b[1])


def _hand_size(lm: dict[str, list[float]]) -> float | None:
    """손 크기 = dist(wrist[0], middle_finger_mcp[9]). 정규화 분모."""
    p0 = _pt(lm, WRIST)
    p9 = _pt(lm, MIDDLE_FINGER_MCP)
    if p0 is None or p9 is None:
        return None
    size = _dist(p0, p9)
    return None if size < 1e-6 else size


def _spread(lm: dict[str, list[float]]) -> float | None:
    """index_tip[8] ~ pinky_tip[20] 거리 / hand_size."""
    size = _hand_size(lm)
    if size is None:
        return None
    p8 = _pt(lm, INDEX_FINGER_TIP)
    p20 = _pt(lm, PINKY_TIP)
    if p8 is None or p20 is None:
        return None
    return _dist(p8, p20) / size


def _pinch_ratio(lm: dict[str, list[float]]) -> float | None:
    """thumb_tip[4] ~ index_tip[8] 거리 / hand_size."""
    size = _hand_size(lm)
    if size is None:
        return None
    p4 = _pt(lm, THUMB_TIP)
    p8 = _pt(lm, INDEX_FINGER_TIP)
    if p4 is None or p8 is None:
        return None
    return _dist(p4, p8) / size


def _is_finger_extended(lm: dict[str, list[float]], finger: str) -> bool:
    """손가락별 펴짐 판정 스텁 — 향후 PINKY_ONLY 등 손가락 지정 제스처용 자리.
    open/fist/pinch 검증은 이 함수를 쓰지 않는다.

    TODO(A3+): MediaPipe Hands 의 각 손가락 tip/pip/mcp 인덱스로 펴짐을 판정.
    """
    raise NotImplementedError("finger-level extension not implemented yet (A3+ 확장 자리)")


# ---------------------------------------------------------------------------
# 제스처 존재 검증 (window = [completed_at_t - tol_ms, completed_at_t + tol_ms])
# face transition 보다 가벼운 "존재" 검증.
# ---------------------------------------------------------------------------

Window = tuple[int, int]


def _in_window(t: int, window: Window) -> bool:
    return window[0] <= t <= window[1]


def _verify_open(frames: list[HandEvidenceFrame], window: Window) -> bool:
    """window 안에 (spread > OPEN_TH AND pinch_ratio >= PINCH_TH) 인 프레임이 존재하면 통과.
    pinch_ratio >= PINCH_TH 조건은 우선순위(pinch 가 아닐 것)를 반영한다 — 핀치는
    손가락을 벌린 채(spread 큼) 엄지-검지만 붙이므로 spread 만으론 open 으로 오통과한다.
    서버 독립 검증의 echo 방어 일관성을 위해 _verify_fist 와 동일하게 pinch 를 배제한다."""
    series = [(f.t, _spread(f.landmarks), _pinch_ratio(f.landmarks)) for f in frames]
    series = [(t, s, p) for (t, s, p) in series if s is not None and p is not None]
    if len(series) < MIN_VALID_FRAMES:
        return False
    return any(
        _in_window(t, window) and s > OPEN_TH and p >= PINCH_TH
        for (t, s, p) in series
    )


def _verify_fist(frames: list[HandEvidenceFrame], window: Window) -> bool:
    """window 안에 (spread < FIST_TH AND pinch_ratio >= PINCH_TH) 인 프레임이 존재하면 통과.
    pinch_ratio >= PINCH_TH 조건은 우선순위(pinch 가 아닐 것)를 반영한다 — 엄지-검지가
    붙은 프레임은 fist 가 아니라 pinch 로 본다(detectHandGesture 우선순위와 동일)."""
    series = [(f.t, _spread(f.landmarks), _pinch_ratio(f.landmarks)) for f in frames]
    series = [(t, s, p) for (t, s, p) in series if s is not None and p is not None]
    if len(series) < MIN_VALID_FRAMES:
        return False
    return any(
        _in_window(t, window) and s < FIST_TH and p >= PINCH_TH
        for (t, s, p) in series
    )


def _verify_pinch(frames: list[HandEvidenceFrame], window: Window) -> bool:
    """window 안에 pinch_ratio < PINCH_TH 인 프레임이 존재하면 통과."""
    series = [(f.t, _pinch_ratio(f.landmarks)) for f in frames]
    series = [(t, r) for (t, r) in series if r is not None]
    if len(series) < MIN_VALID_FRAMES:
        return False
    return any(_in_window(t, window) and r < PINCH_TH for (t, r) in series)


def _verify_instruction(inst: HandEvidenceInstruction, window: Window) -> bool:
    """instruction.type 별 제스처 검증 디스패치. 미지원 타입 → False(fail-closed)."""
    t = inst.type
    if t == "open_hand":
        return _verify_open(inst.frames, window)
    if t == "fist":
        return _verify_fist(inst.frames, window)
    if t == "pinch":
        return _verify_pinch(inst.frames, window)
    return False


# ---------------------------------------------------------------------------
# 공개 진입점 — public.py 가 face hit 과 AND 결합
# ---------------------------------------------------------------------------

def check_hand_evidence(
    answer: "FaceChallengeAnswer",
    face_behavioral_data: dict | None,
) -> bool:
    """발급 정답의 손동작 시퀀스(expected_hand_instruction_types)와 위젯이 보낸
    face_behavioral_data.hand_evidence 를 대조해 손동작 통과 여부를 반환.
    전 과정 fail-closed(예외/형식오류/증거부족 → False).

    ★ 하위호환: expected_hand_instruction_types 가 비어있으면(=hand 미요구 챌린지,
       기존 face-only 발급분) **True 를 반환**한다 → 기존 face_mission 동작 불변.

    1) expected 가 비면 True (하위호환).
    2) face_behavioral_data 파싱 → hand_evidence.instructions 추출(None → 빈 리스트).
    3) 1차 시퀀스 게이트: 증거 instruction type 시퀀스 == expected(순서·내용·길이).
    4) 각 instruction: completed_at_t 必 + type별 존재 검증 통과.
    5) 전부 통과해야 True.
    """
    try:
        expected = list(answer.expected_hand_instruction_types)
        if not expected:
            return True  # 하위호환: hand 미요구 챌린지

        if face_behavioral_data is None:
            return False
        env = _HandEvidenceEnvelope.model_validate(face_behavioral_data)
        insts = env.hand_evidence.instructions if env.hand_evidence is not None else []

        # HandInstructionType(str Enum) / 혹시 모를 str 둘 다 안전하게 value 화.
        expected_values = [getattr(t, "value", t) for t in expected]
        if [i.type for i in insts] != expected_values:
            return False

        # A3 좌우: 발급이 기대 손을 지정한 경우(None 아님) 관측 hand 와 대조.
        # expected_hand_sides 가 비었거나(구버전) 해당 항목이 None 이면 손 무관(기존 동작).
        expected_sides = list(getattr(answer, "expected_hand_sides", None) or [])

        tol_ms = int(answer.tolerance_sec * 1000)
        for i, inst in enumerate(insts):
            if inst.completed_at_t is None:
                return False
            exp_side = expected_sides[i] if i < len(expected_sides) else None
            if exp_side is not None and inst.hand != exp_side:
                return False
            window: Window = (inst.completed_at_t - tol_ms, inst.completed_at_t + tol_ms)
            if not _verify_instruction(inst, window):
                return False
        return True
    except Exception:
        logger.warning("check_hand_evidence fail-closed (parse/verify error)", exc_info=True)
        return False
