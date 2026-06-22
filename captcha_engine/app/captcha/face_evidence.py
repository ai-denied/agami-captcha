"""
Face Mission 서버측 원시 랜드마크 기하 검증 (A2)
================================================
A1 위젯이 answer 페이로드의 ``face_behavioral_data`` 에 실어 보내는 원시 랜드마크
시계열(``face_evidence``)을 서버가 받아, 위젯
(``captcha-frontend/src/lib/faceDetection.js``)의 기하 식(EAR/yaw/smile/nod)을
**1:1 로 복제**해 "그 동작이 실제로 일어났는가"를 전이(transition) 단위로 검증한다.

기존 ``check_face_hit`` 은 클라이언트가 보고한 ``completed_instructions`` 를 발급
spec 에 노출된 ``expected_instruction_types`` 와 단순 비교했다. 정답이 발급 응답에
들어있으므로 봇이 그대로 echo 하면 100% 통과 가능했다. ``check_face_evidence`` 가
이를 대체해 echo 우회를 차단한다.

좌표 컨벤션: ``landmarks`` 는 ``dict[str, [x, y]]`` (정규화 0~1, z 없음). 위젯이
변환 없이 보낸 raw 정규화 좌표이며 서버도 동일 좌표로 계산한다(train/serve 일치).

모든 검증은 **fail-closed**: 입력 부족 / 파싱 실패 / 식 산출 불가 → 검증 실패(False).
"""

from __future__ import annotations

import logging
import math
from typing import TYPE_CHECKING, Any

from pydantic import BaseModel, ConfigDict, Field

if TYPE_CHECKING:
    from app.captcha.challenge_types import FaceChallengeAnswer

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# 위젯(faceDetection.js)과 1:1 동일한 상수 (값은 faceDetection.js 와 정확히 일치)
# ---------------------------------------------------------------------------
LEFT_EYE_EAR_INDICES = [362, 385, 387, 263, 373, 380]   # faceDetection.js:21
RIGHT_EYE_EAR_INDICES = [33, 160, 158, 133, 153, 144]   # faceDetection.js:22
NOSE_TIP = 1            # :25
IMG_LEFT_CHEEK = 234    # :28
IMG_RIGHT_CHEEK = 454   # :29
MOUTH_LEFT = 61         # :32
MOUTH_RIGHT = 291       # :33
MOUTH_TOP = 13          # :34
MOUTH_BOTTOM = 14       # :35

EAR_THRESHOLD = 0.2          # :38
YAW_THRESHOLD_DEG = 15       # :41
SMILE_RATIO_THRESHOLD = 4.0  # :44
NOD_WINDOW_MS = 500          # :47
NOD_RANGE_THRESHOLD = 0.02   # :48
NOD_MIN_FRAMES = 5           # detectNod: recent.length < 5 → false (:150)

# 서버측 전이 검증 파라미터 (위젯 boolean 게이팅엔 없는, A2 명세[2-3]의 추가 기준)
MIN_VALID_FRAMES = 5    # 유효(식 산출 가능) 프레임이 이보다 적으면 검증 실패
SMILE_CONSEC = 3        # smile: ratio>임계가 연속 N프레임 이상이어야 통과


# ---------------------------------------------------------------------------
# 증거 페이로드 스키마 (face_behavioral_data 내부 구조)
# ---------------------------------------------------------------------------

class FaceEvidenceFrame(BaseModel):
    model_config = ConfigDict(extra="ignore")
    t: int
    landmarks: dict[str, list[float]]


class FaceEvidenceInstruction(BaseModel):
    model_config = ConfigDict(extra="ignore")
    type: str
    completed_at_t: int | None = None
    frames: list[FaceEvidenceFrame] = Field(default_factory=list)


class FaceEvidenceInner(BaseModel):
    model_config = ConfigDict(extra="ignore")
    instructions: list[FaceEvidenceInstruction] = Field(default_factory=list)


class FaceEvidence(BaseModel):
    """A1 위젯이 보내는 face_behavioral_data 의 typed 뷰. 잉여 키(time_taken_ms,
    steps_count 등)는 extra="ignore" 로 무시한다."""
    model_config = ConfigDict(extra="ignore")
    evidence_version: int
    frame_w: int
    frame_h: int
    face_evidence: FaceEvidenceInner
    hand_evidence: Any | None = None


# ---------------------------------------------------------------------------
# 기하 헬퍼 — faceDetection.js 1:1
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


def _ear(lm: dict[str, list[float]], indices: list[int]) -> float | None:
    """faceDetection.js ear() 1:1. 6점 중 하나라도 누락이면 None(미산출)."""
    pts = [_pt(lm, i) for i in indices]
    if any(p is None for p in pts):
        return None
    p1, p2, p3, p4, p5, p6 = pts  # type: ignore[misc]
    horz = _dist(p1, p4)
    if horz < 1e-6:
        return 0.0
    return (_dist(p2, p6) + _dist(p3, p5)) / (2 * horz)


def _yaw(lm: dict[str, list[float]]) -> float | None:
    """faceDetection.js getHeadYaw() 1:1 (사용자 관점 부호반전 포함)."""
    nose = _pt(lm, NOSE_TIP)
    left = _pt(lm, IMG_LEFT_CHEEK)
    right = _pt(lm, IMG_RIGHT_CHEEK)
    if nose is None or left is None or right is None:
        return None
    mid_x = (left[0] + right[0]) / 2
    cheek_w = abs(right[0] - left[0])
    if cheek_w < 1e-6:
        return 0.0
    offset = (nose[0] - mid_x) / cheek_w
    return -offset * 180


def _smile_ratio(lm: dict[str, list[float]]) -> float | None:
    """faceDetection.js isSmiling() 의 비율부 1:1. height<1e-6 → 0.0 (위젯 false 와 동치)."""
    ml = _pt(lm, MOUTH_LEFT)
    mr = _pt(lm, MOUTH_RIGHT)
    mt = _pt(lm, MOUTH_TOP)
    mb = _pt(lm, MOUTH_BOTTOM)
    if ml is None or mr is None or mt is None or mb is None:
        return None
    width = _dist(ml, mr)
    height = _dist(mt, mb)
    if height < 1e-6:
        return 0.0
    return width / height


def _nose_y(lm: dict[str, list[float]]) -> float | None:
    p = _pt(lm, NOSE_TIP)
    return None if p is None else p[1]


# ---------------------------------------------------------------------------
# 전이(transition) 검증 — "그 동작이 실제로 일어났는가"
# window = [completed_at_t - tol_ms, completed_at_t + tol_ms]
# ---------------------------------------------------------------------------

Window = tuple[int, int]


def _in_window(t: int, window: Window) -> bool:
    return window[0] <= t <= window[1]


def _verify_blink(frames: list[FaceEvidenceFrame], eye_indices: list[int], window: Window) -> bool:
    """window 안에 감김(EAR<0.2)이 발생하고, 시계열 어딘가에 뜸(EAR>0.2)도 있어야 통과.
    (정적으로 늘 감김/늘 뜸 → 실패 = 사진/가림 차단)."""
    series = [(f.t, _ear(f.landmarks, eye_indices)) for f in frames]
    series = [(t, e) for (t, e) in series if e is not None]
    if len(series) < MIN_VALID_FRAMES:
        return False
    closed_in_window = any(_in_window(t, window) and e < EAR_THRESHOLD for (t, e) in series)
    open_anywhere = any(e > EAR_THRESHOLD for (_, e) in series)
    return closed_in_window and open_anywhere


def _verify_turn(frames: list[FaceEvidenceFrame], is_left: bool, window: Window) -> bool:
    """window 안에 목표 회전(turn_left: yaw<-15 / turn_right: yaw>+15)에 도달하고,
    시계열 어딘가에 정면(|yaw|<15)도 있어야 통과 (실제 회전 = 도달+복귀)."""
    series = [(f.t, _yaw(f.landmarks)) for f in frames]
    series = [(t, y) for (t, y) in series if y is not None]
    if len(series) < MIN_VALID_FRAMES:
        return False
    if is_left:
        reached = any(_in_window(t, window) and y < -YAW_THRESHOLD_DEG for (t, y) in series)
    else:
        reached = any(_in_window(t, window) and y > YAW_THRESHOLD_DEG for (t, y) in series)
    frontal = any(abs(y) < YAW_THRESHOLD_DEG for (_, y) in series)
    return reached and frontal


def _verify_smile(frames: list[FaceEvidenceFrame], window: Window) -> bool:
    """window 안에서 smileRatio>4.0 이 연속 SMILE_CONSEC(3) 프레임 이상 유지되면 통과."""
    series = [(f.t, _smile_ratio(f.landmarks)) for f in frames]
    series = [(t, r) for (t, r) in series if r is not None]
    if len(series) < MIN_VALID_FRAMES:
        return False
    win = sorted([(t, r) for (t, r) in series if _in_window(t, window)], key=lambda x: x[0])
    run = 0
    for (_, r) in win:
        if r > SMILE_RATIO_THRESHOLD:
            run += 1
            if run >= SMILE_CONSEC:
                return True
        else:
            run = 0
    return False


def _verify_nod(frames: list[FaceEvidenceFrame], window: Window) -> bool:
    """faceDetection.js detectNod 를 증거 프레임에 슬라이딩 적용. window 안의 t 를
    anchor 로 삼아 직전 500ms(recent)에서: len>=5 AND y범위>=0.02 AND 방향전환>=1 이면 통과."""
    series = [(f.t, _nose_y(f.landmarks)) for f in frames]
    series = sorted([(t, y) for (t, y) in series if y is not None], key=lambda x: x[0])
    if len(series) < NOD_MIN_FRAMES:
        return False
    for anchor_t, _ in series:
        if not _in_window(anchor_t, window):
            continue
        recent = [(t, y) for (t, y) in series if 0 <= anchor_t - t < NOD_WINDOW_MS]
        if len(recent) < NOD_MIN_FRAMES:
            continue
        ys = [y for (_, y) in recent]
        if max(ys) - min(ys) < NOD_RANGE_THRESHOLD:
            continue
        direction_changes = 0
        prev_dir = 0
        for i in range(1, len(recent)):
            dy = recent[i][1] - recent[i - 1][1]
            if abs(dy) < 1e-4:
                continue
            cur_dir = 1 if dy > 0 else -1
            if prev_dir != 0 and cur_dir != prev_dir:
                direction_changes += 1
            prev_dir = cur_dir
        if direction_changes >= 1:
            return True
    return False


def _verify_instruction(inst: FaceEvidenceInstruction, window: Window) -> bool:
    """instruction.type 별 전이 검증 디스패치. 미지원 타입 → False(fail-closed)."""
    t = inst.type
    if t == "blink_left":
        return _verify_blink(inst.frames, LEFT_EYE_EAR_INDICES, window)
    if t == "blink_right":
        return _verify_blink(inst.frames, RIGHT_EYE_EAR_INDICES, window)
    if t == "turn_left":
        return _verify_turn(inst.frames, True, window)
    if t == "turn_right":
        return _verify_turn(inst.frames, False, window)
    if t == "smile":
        return _verify_smile(inst.frames, window)
    if t == "nod":
        return _verify_nod(inst.frames, window)
    return False


# ---------------------------------------------------------------------------
# 공개 진입점 — public.py 의 check_face_hit 를 대체
# ---------------------------------------------------------------------------

def check_face_evidence(
    answer: "FaceChallengeAnswer",
    face_behavioral_data: dict | None,
) -> bool:
    """발급 정답(answer)과 위젯이 보낸 face_behavioral_data 를 대조해 face_mission
    통과 여부를 반환. 전 과정 fail-closed(예외/형식오류/증거부족 → False).

    1) face_behavioral_data 를 FaceEvidence 로 파싱(None/형식오류 → False).
    2) 1차 시퀀스 게이트: 증거 instruction 의 type 시퀀스가 expected_instruction_types
       와 순서·내용·길이 모두 일치해야 함.
    3) 각 instruction: completed_at_t 必, type별 전이 검증 통과해야 함.
    4) 전부 통과해야 True.
    """
    try:
        if face_behavioral_data is None:
            return False
        ev = FaceEvidence.model_validate(face_behavioral_data)

        expected = list(answer.expected_instruction_types)
        if not expected:
            return False  # 발급 정답이 비어있으면(이론상 불가) fail-closed

        insts = ev.face_evidence.instructions
        if [i.type for i in insts] != expected:
            return False  # 1차 시퀀스 게이트

        tol_ms = int(answer.tolerance_sec * 1000)
        for inst in insts:
            if inst.completed_at_t is None:
                return False
            window: Window = (inst.completed_at_t - tol_ms, inst.completed_at_t + tol_ms)
            if not _verify_instruction(inst, window):
                return False
        return True
    except Exception:
        logger.warning("check_face_evidence fail-closed (parse/verify error)", exc_info=True)
        return False
