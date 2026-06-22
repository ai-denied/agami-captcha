"""
Tests for app/captcha/face_evidence.py  (A2 — 서버측 원시 랜드마크 기하 검증)
==========================================================================
핵심 목적: check_face_evidence 가 "실제 동작이 일어난 증거" 를 요구함으로써
라벨 echo(발급 spec 의 instruction 을 그대로 되돌려보내는) 100% 우회를 차단함을 증명.

합성 픽스처는 crafted 좌표로 목표 EAR/yaw/smile/nod 를 만든다.
실행: python tests/test_face_evidence.py  또는  python -m pytest tests/test_face_evidence.py
"""

from __future__ import annotations

import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.captcha.challenge_types import FaceChallengeAnswer
from app.captcha.face_evidence import (
    LEFT_EYE_EAR_INDICES,
    check_face_evidence,
)

_NOW = datetime(2025, 1, 1, tzinfo=timezone.utc)


# ---------------------------------------------------------------------------
# 합성 픽스처 헬퍼
# ---------------------------------------------------------------------------

def make_answer(expected_types, tolerance_sec: float = 1.0) -> FaceChallengeAnswer:
    return FaceChallengeAnswer(
        challenge_id="test_cid",
        expected_instruction_types=list(expected_types),
        tolerance_sec=tolerance_sec,
        created_at=_NOW,
        expires_at=_NOW + timedelta(seconds=40),
    )


def eye_landmarks(eye_indices, ear_value: float) -> dict:
    """eye_indices=[p1..p6]. EAR = (|p2-p6|+|p3-p5|)/(2|p1-p4|) = V/H 로 배치.
    H=0.1 고정, V=0.1*ear_value → ear()==ear_value."""
    p1, p2, p3, p4, p5, p6 = eye_indices
    h = 0.1
    v = 0.1 * ear_value
    return {
        str(p1): [0.0, 0.0],
        str(p4): [h, 0.0],
        str(p2): [0.03, v / 2], str(p6): [0.03, -v / 2],
        str(p3): [0.07, v / 2], str(p5): [0.07, -v / 2],
    }


def yaw_landmarks(yaw_deg: float) -> dict:
    """L_cheek(234) x=0.3, R_cheek(454) x=0.7 → midX=0.5, cheekW=0.4.
    yaw = -((nose.x-0.5)/0.4)*180 → nose.x = 0.5 - (yaw/180)*0.4."""
    nx = 0.5 - (yaw_deg / 180.0) * 0.4
    return {"1": [nx, 0.5], "234": [0.3, 0.5], "454": [0.7, 0.5]}


def smile_landmarks(ratio: float) -> dict:
    """width=|61-291|, height=|13-14|. width=0.2 고정, height=0.2/ratio → ratio."""
    width = 0.2
    height = width / ratio
    return {
        "61": [0.4, 0.5], "291": [0.4 + width, 0.5],
        "13": [0.5, 0.5], "14": [0.5, 0.5 + height],
    }


def nod_landmarks(nose_y: float) -> dict:
    return {"1": [0.5, nose_y]}


def frames(landmarks_seq, t0: int = 0, step: int = 66) -> list:
    return [{"t": t0 + i * step, "landmarks": lm} for i, lm in enumerate(landmarks_seq)]


def inst(type_: str, frames_, completed_at_t):
    return {"type": type_, "completed_at_t": completed_at_t, "frames": frames_}


def fbd(instructions) -> dict:
    """A1 위젯 payload 와 동일한 face_behavioral_data 구조 (+ 잉여키로 extra=ignore 확인)."""
    return {
        "evidence_version": 1,
        "frame_w": 480,
        "frame_h": 480,
        "face_evidence": {"instructions": instructions},
        "hand_evidence": None,
        "time_taken_ms": 3000,
        "steps_count": len(instructions),
    }


# ---------------------------------------------------------------------------
# 1~3. blink — 실제 감김 vs 정적 replay/occlusion
# ---------------------------------------------------------------------------

def test_blink_left_real_motion_pass() -> None:
    # 앞부분 open(EAR≈0.30), completed_at_t 부근 closed(≈0.04)
    open_f = frames([eye_landmarks(LEFT_EYE_EAR_INDICES, 0.30)] * 8, t0=0, step=66)
    closed_f = frames([eye_landmarks(LEFT_EYE_EAR_INDICES, 0.04)] * 8, t0=1000, step=66)
    answer = make_answer(["blink_left"])
    assert check_face_evidence(answer, fbd([inst("blink_left", open_f + closed_f, 1400)])) is True


def test_blink_static_open_fail() -> None:
    # 전 프레임 open(늘 0.30) → 감김 없음 → False
    f = frames([eye_landmarks(LEFT_EYE_EAR_INDICES, 0.30)] * 16, t0=0, step=66)
    answer = make_answer(["blink_left"])
    assert check_face_evidence(answer, fbd([inst("blink_left", f, 500)])) is False


def test_blink_static_closed_fail() -> None:
    # 전 프레임 closed(늘 0.04) → 뜬 적 없음 → False (사진/가림 차단)
    f = frames([eye_landmarks(LEFT_EYE_EAR_INDICES, 0.04)] * 16, t0=0, step=66)
    answer = make_answer(["blink_left"])
    assert check_face_evidence(answer, fbd([inst("blink_left", f, 500)])) is False


# ---------------------------------------------------------------------------
# 4. turn — 실제 회전 vs 정면 고정
# ---------------------------------------------------------------------------

def test_turn_left_real_motion_pass() -> None:
    frontal = frames([yaw_landmarks(0)] * 8, t0=0, step=66)
    turned = frames([yaw_landmarks(-20)] * 8, t0=1000, step=66)
    answer = make_answer(["turn_left"])
    assert check_face_evidence(answer, fbd([inst("turn_left", frontal + turned, 1400)])) is True


def test_turn_left_static_frontal_fail() -> None:
    f = frames([yaw_landmarks(0)] * 16, t0=0, step=66)
    answer = make_answer(["turn_left"])
    assert check_face_evidence(answer, fbd([inst("turn_left", f, 500)])) is False


# ---------------------------------------------------------------------------
# 5. smile — 지속 vs 미달
# ---------------------------------------------------------------------------

def test_smile_sustained_pass() -> None:
    f = frames([smile_landmarks(5.0)] * 8, t0=1000, step=66)
    answer = make_answer(["smile"])
    assert check_face_evidence(answer, fbd([inst("smile", f, 1200)])) is True


def test_smile_below_threshold_fail() -> None:
    f = frames([smile_landmarks(2.0)] * 8, t0=1000, step=66)
    answer = make_answer(["smile"])
    assert check_face_evidence(answer, fbd([inst("smile", f, 1200)])) is False


# ---------------------------------------------------------------------------
# 6. echo 공격 차단 (이 테스트가 A2 의 핵심 증명)
# ---------------------------------------------------------------------------

def test_echo_attack_no_evidence_none_fail() -> None:
    # expected 는 맞지만 face_behavioral_data 가 아예 없음 → False
    answer = make_answer(["smile"])
    assert check_face_evidence(answer, None) is False


def test_echo_attack_empty_instructions_fail() -> None:
    # 라벨만 맞고 증거 instructions 가 비어있음 → 1차 게이트에서 False
    answer = make_answer(["smile"])
    assert check_face_evidence(answer, fbd([])) is False


# ---------------------------------------------------------------------------
# 7. 시퀀스 순서/내용 불일치
# ---------------------------------------------------------------------------

def test_sequence_order_mismatch_fail() -> None:
    # 발급=[turn_left, smile], 증거=[smile, turn_left] → 순서 불일치 → False
    turned = frames([yaw_landmarks(0)] * 4 + [yaw_landmarks(-20)] * 4, t0=0, step=66)
    smile_f = frames([smile_landmarks(5.0)] * 8, t0=0, step=66)
    answer = make_answer(["turn_left", "smile"])
    evidence = fbd([inst("smile", smile_f, 200), inst("turn_left", turned, 200)])
    assert check_face_evidence(answer, evidence) is False


# ---------------------------------------------------------------------------
# 8. completed_at_t 누락
# ---------------------------------------------------------------------------

def test_completed_at_t_none_fail() -> None:
    open_f = frames([eye_landmarks(LEFT_EYE_EAR_INDICES, 0.30)] * 8, t0=0, step=66)
    closed_f = frames([eye_landmarks(LEFT_EYE_EAR_INDICES, 0.04)] * 8, t0=1000, step=66)
    answer = make_answer(["blink_left"])
    assert check_face_evidence(answer, fbd([inst("blink_left", open_f + closed_f, None)])) is False


# ---------------------------------------------------------------------------
# 9. nod — 끄덕임 발생 vs 정지
# ---------------------------------------------------------------------------

def test_nod_real_motion_pass() -> None:
    ys = [0.50, 0.53, 0.50, 0.53, 0.50, 0.53, 0.50, 0.53]
    f = frames([nod_landmarks(y) for y in ys], t0=1000, step=66)
    answer = make_answer(["nod"])
    assert check_face_evidence(answer, fbd([inst("nod", f, 1400)])) is True


def test_nod_static_fail() -> None:
    f = frames([nod_landmarks(0.50)] * 8, t0=1000, step=66)
    answer = make_answer(["nod"])
    assert check_face_evidence(answer, fbd([inst("nod", f, 1400)])) is False


if __name__ == "__main__":
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    failed = 0
    for fn in tests:
        try:
            fn()
            print(f"PASS  {fn.__name__}")
        except AssertionError as e:
            failed += 1
            print(f"FAIL  {fn.__name__}: {e}")
    print(f"\n{len(tests) - failed}/{len(tests)} passed")
    sys.exit(1 if failed else 0)
