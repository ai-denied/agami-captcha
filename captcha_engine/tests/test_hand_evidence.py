"""
Tests for app/captcha/hand_evidence.py  (A3 — 서버측 손동작 기하 검증)
======================================================================
핵심 목적:
  1) C-2 강화 증명 — 제스처(open/fist/pinch)는 window 안에 조건충족 프레임이
     GESTURE_MATCH_FRAMES 개 이상이어야 통과한다(과거 1프레임 'any' → "대충 스침" 차단).
  2) fail-closed 일관성 — 증거 없음/시퀀스 불일치/completed_at_t 누락/프레임 부족 → False.
  3) 하위호환 — expected_hand 가 비면 True(호출부 public.py 가 정책 가드로 차단; 여기선 함수 계약).
  4) finger_pose — frames 재계산 손가락 일치(_verify_fingers), 손가락 미지정 시 fail-closed.

합성 픽스처는 crafted 좌표로 목표 spread/pinch/손가락폄을 만든다(test_face_evidence 패턴).
실행: python tests/test_hand_evidence.py  또는  python -m pytest tests/test_hand_evidence.py
"""

from __future__ import annotations

import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.captcha.challenge_types import FaceChallengeAnswer
from app.captcha.hand_evidence import (
    check_hand_evidence,
    GESTURE_MATCH_FRAMES,
    MIN_VALID_FRAMES,
    FINGER_MATCH_FRAMES,
)

_NOW = datetime(2025, 1, 1, tzinfo=timezone.utc)


# ---------------------------------------------------------------------------
# 합성 픽스처 헬퍼
# ---------------------------------------------------------------------------

def make_hand_answer(expected_hand, expected_fingers=None, tolerance_sec: float = 0.6):
    kwargs = dict(
        challenge_id="test_cid",
        expected_instruction_types=[],  # check_hand_evidence 는 이 필드를 읽지 않음
        expected_hand_instruction_types=list(expected_hand),
        tolerance_sec=tolerance_sec,
        created_at=_NOW,
        expires_at=_NOW + timedelta(seconds=40),
    )
    if expected_fingers is not None:
        kwargs["expected_fingers"] = expected_fingers
    return FaceChallengeAnswer(**kwargs)


def hand_lm(spread_val: float, pinch_val: float) -> dict:
    """hand_size=dist(0,9)=0.4 고정. spread=dist(8,20)/0.4, pinch=dist(4,8)/0.4 가 되도록 배치."""
    return {
        "0": [0.5, 0.9],                       # wrist
        "9": [0.5, 0.5],                       # middle_mcp → hand_size=0.4
        "8": [0.5, 0.3],                       # index_tip
        "20": [0.5 + 0.4 * spread_val, 0.3],   # pinky_tip → spread
        "4": [0.5, 0.3 + 0.4 * pinch_val],     # thumb_tip → pinch
    }


# open: spread 1.0(>0.80), pinch 0.5(>=0.25) / fist: spread 0.3(<0.79) / pinch: pinch 0.05(<0.25)
def open_lm() -> dict:
    return hand_lm(1.0, 0.5)


def fist_lm() -> dict:
    return hand_lm(0.3, 0.5)


def pinch_lm() -> dict:
    return hand_lm(1.0, 0.05)


# 손가락별 (MCP, PIP, TIP) — _is_finger_extended 가 읽는 3점. extended → TIP 이 MCP 에서 멂.
_FINGER_IDX = {
    "thumb": (1, 2, 4),
    "index": (5, 6, 8),
    "middle": (9, 10, 12),
    "ring": (13, 14, 16),
    "pinky": (17, 18, 20),
}
_FINGER_X = {"thumb": 0.2, "index": 0.35, "middle": 0.5, "ring": 0.65, "pinky": 0.8}


def fingers_lm(extended) -> dict:
    """펴진 손가락 집합 extended 를 가진 한 프레임. dist(TIP,MCP)/dist(PIP,MCP) > RATIO → 폄."""
    ext = set(extended)
    lm = {"0": [0.5, 0.95]}  # wrist (pt9=middle_mcp 는 아래 루프에서 [0.5,0.6] → hand_size=0.35)
    for finger, (mcp, pip, tip) in _FINGER_IDX.items():
        x = _FINGER_X[finger]
        lm[str(mcp)] = [x, 0.6]
        lm[str(pip)] = [x, 0.5]
        lm[str(tip)] = [x, 0.3] if finger in ext else [x, 0.62]  # 폄: 멀리 / 접힘: MCP 근처
    return lm


def frames(landmarks_seq, t0: int = 1000, step: int = 66) -> list:
    return [{"t": t0 + i * step, "landmarks": lm} for i, lm in enumerate(landmarks_seq)]


def inst(type_: str, frames_, completed_at_t):
    return {"type": type_, "completed_at_t": completed_at_t, "frames": frames_}


def hand_fbd(instructions) -> dict:
    """face_behavioral_data 중 hand_evidence 슬롯만 (+잉여키로 extra=ignore 확인)."""
    return {
        "evidence_version": 1,
        "frame_w": 480,
        "frame_h": 480,
        "face_evidence": None,
        "hand_evidence": {"instructions": instructions},
    }


# completed_at_t=1400, tolerance=0.6 → window [800, 2000]. 아래 프레임들은 모두 이 안.
_CT = 1400


# ---------------------------------------------------------------------------
# 1. 제스처 지속(C-2 핵심) — 충분히 유지하면 통과
# ---------------------------------------------------------------------------

def test_open_sustained_pass() -> None:
    n = GESTURE_MATCH_FRAMES + 3
    f = frames([open_lm()] * n)
    answer = make_hand_answer(["open_hand"])
    assert check_hand_evidence(answer, hand_fbd([inst("open_hand", f, _CT)])) is True


def test_fist_sustained_pass() -> None:
    n = GESTURE_MATCH_FRAMES + 3
    f = frames([fist_lm()] * n)
    answer = make_hand_answer(["fist"])
    assert check_hand_evidence(answer, hand_fbd([inst("fist", f, _CT)])) is True


def test_pinch_sustained_pass() -> None:
    n = GESTURE_MATCH_FRAMES + 3
    f = frames([pinch_lm()] * n)
    answer = make_hand_answer(["pinch"])
    assert check_hand_evidence(answer, hand_fbd([inst("pinch", f, _CT)])) is True


# ---------------------------------------------------------------------------
# 2. 제스처 '스침'(C-2 회귀) — 조건충족 프레임이 N 미만이면 실패
#    (valid 프레임은 MIN_VALID_FRAMES 이상으로 둬서 'floor' 가 아니라 'count' 게이트를 친다)
# ---------------------------------------------------------------------------

def test_open_flash_fail() -> None:
    matched = [open_lm()] * (GESTURE_MATCH_FRAMES - 1)   # open 은 N-1 개뿐
    filler = [fist_lm()] * (MIN_VALID_FRAMES + 1)        # 나머지는 유효하지만 open 아님
    f = frames(matched + filler)
    answer = make_hand_answer(["open_hand"])
    # valid = (N-1)+(MIN+1) >= MIN_VALID_FRAMES 이지만 open matches = N-1 < N → False
    assert check_hand_evidence(answer, hand_fbd([inst("open_hand", f, _CT)])) is False


def test_gesture_too_few_valid_frames_fail() -> None:
    f = frames([open_lm()] * (MIN_VALID_FRAMES - 1))     # 유효 프레임 자체가 floor 미만
    answer = make_hand_answer(["open_hand"])
    assert check_hand_evidence(answer, hand_fbd([inst("open_hand", f, _CT)])) is False


# ---------------------------------------------------------------------------
# 3. fail-closed / echo 차단
# ---------------------------------------------------------------------------

def test_none_data_with_expected_fail() -> None:
    # hand 를 요구하는데 face_behavioral_data 가 아예 없음 → False
    answer = make_hand_answer(["open_hand"])
    assert check_hand_evidence(answer, None) is False


def test_sequence_mismatch_fail() -> None:
    # 발급=open_hand, 증거 type=fist → 1차 시퀀스 게이트 False
    f = frames([fist_lm()] * (GESTURE_MATCH_FRAMES + 3))
    answer = make_hand_answer(["open_hand"])
    assert check_hand_evidence(answer, hand_fbd([inst("fist", f, _CT)])) is False


def test_completed_at_t_none_fail() -> None:
    f = frames([open_lm()] * (GESTURE_MATCH_FRAMES + 3))
    answer = make_hand_answer(["open_hand"])
    assert check_hand_evidence(answer, hand_fbd([inst("open_hand", f, None)])) is False


def test_empty_instructions_fail() -> None:
    answer = make_hand_answer(["open_hand"])
    assert check_hand_evidence(answer, hand_fbd([])) is False


# ---------------------------------------------------------------------------
# 4. 하위호환 — expected_hand 가 비면 True (함수 계약). 프로덕션 자동통과는 public.py(C-0)가 차단.
# ---------------------------------------------------------------------------

def test_empty_expected_backcompat_true() -> None:
    answer = make_hand_answer([])  # expected_hand 비어있음
    assert check_hand_evidence(answer, hand_fbd([])) is True
    assert check_hand_evidence(answer, None) is True


# ---------------------------------------------------------------------------
# 5. finger_pose — frames 재계산 손가락 일치 / 미지정 fail-closed / 불일치 차단
# ---------------------------------------------------------------------------

def test_finger_pose_index_pass() -> None:
    n = FINGER_MATCH_FRAMES + 3
    f = frames([fingers_lm({"index"})] * n)
    answer = make_hand_answer(["finger_pose"], expected_fingers=[["index"]])
    assert check_hand_evidence(answer, hand_fbd([inst("finger_pose", f, _CT)])) is True


def test_finger_pose_missing_spec_fail() -> None:
    # finger_pose 인데 expected_fingers 미지정 → 검증 본체가 없으므로 fail-closed
    n = FINGER_MATCH_FRAMES + 3
    f = frames([fingers_lm({"index"})] * n)
    answer = make_hand_answer(["finger_pose"])  # expected_fingers 기본 []
    assert check_hand_evidence(answer, hand_fbd([inst("finger_pose", f, _CT)])) is False


def test_finger_pose_wrong_fingers_fail() -> None:
    # 검지만 펴라는데 다 펴고 있음(여분 폄) → _fingers_match 불일치 → False
    n = FINGER_MATCH_FRAMES + 3
    f = frames([fingers_lm({"index", "middle", "ring", "pinky"})] * n)
    answer = make_hand_answer(["finger_pose"], expected_fingers=[["index"]])
    assert check_hand_evidence(answer, hand_fbd([inst("finger_pose", f, _CT)])) is False


if __name__ == "__main__":
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    failed = 0
    for fn in tests:
        try:
            fn()
            print(f"  PASS  {fn.__name__}")
        except AssertionError:
            failed += 1
            print(f"  FAIL  {fn.__name__}")
    print(f"\n{len(tests) - failed}/{len(tests)} passed")
    sys.exit(1 if failed else 0)
