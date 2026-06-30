"""
Tests for app/captcha/face_decision_adapter.py  (Phase 3 갈래A — 쌍 구조 누적 판정 어댑터)
==========================================================================================
build_rounds(evidence) → 3 MissionRound(쌍) → decide_three_round_captcha 의
end-to-end 동작을 검증한다.

- mission_pass = (얼굴 미션 통과) AND (손 미션 통과) — 실제 _verify_instruction 재사용으로 산출.
- 완화 정책: 1쌍 실패는 PASS(total_risk 0.70<1.20), 2쌍 실패는 FAIL(failed_mission>=2).
- fail-closed: None/파싱오류/시퀀스 불일치/빈 expected → 전 라운드 실패 → FAIL.
- positional / round_id forward-compat 매핑.

face_detected 는 무거운 FaceFeatureExtractor(full landmark set 필요)에 의존하므로, 합성
랜드마크로는 항상 미검출이 된다. 따라서 mission_pass 중심 케이스에서는 _face_detected 를
스왑해 face 축을 고정하고(모델팀 파일의 데모와 동일한 격리), 게이트 자체는 별도 단위 검증한다.

실행: python tests/test_face_decision_adapter.py  또는  python -m pytest tests/test_face_decision_adapter.py
"""

from __future__ import annotations

import sys
import types
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import app.captcha.face_decision_adapter as fda
from app.captcha.face_decision_adapter import build_rounds
from app.captcha.captcha_decision import decide_three_round_captcha


# ---------------------------------------------------------------------------
# 합성 픽스처
# ---------------------------------------------------------------------------

_CT = 1400  # completed_at_t. tolerance 0.6 → window [800, 2000]


def smile_lm(ratio: float) -> dict:
    """width=|61-291|=0.2 고정, height=|13-14|=0.2/ratio → _smile_ratio == ratio."""
    return {"61": [0.4, 0.5], "291": [0.6, 0.5], "13": [0.5, 0.5], "14": [0.5, 0.5 + 0.2 / ratio]}


def hand_lm(spread: float, pinch: float) -> dict:
    """hand_size=dist(0,9)=0.4. spread=dist(8,20)/0.4, pinch=dist(4,8)/0.4."""
    return {
        "0": [0.5, 0.9], "9": [0.5, 0.5], "8": [0.5, 0.3],
        "20": [0.5 + 0.4 * spread, 0.3], "4": [0.5, 0.3 + 0.4 * pinch],
    }


def _frames(lm: dict, n: int = 8, t0: int = 1000, step: int = 66) -> list:
    return [{"t": t0 + i * step, "landmarks": lm} for i in range(n)]


# 얼굴: smile ratio 5.0(>4.0, 8연속) → 통과 / 2.0(<4.0) → 실패
FACE_PASS = ("smile", _frames(smile_lm(5.0)), _CT)
FACE_FAIL = ("smile", _frames(smile_lm(2.0)), _CT)
# 손: open_hand 타입. spread 1.0(>0.80) 8프레임 → 통과 / 0.3(주먹) → 실패(타입은 open_hand)
HAND_PASS = ("open_hand", _frames(hand_lm(1.0, 0.5)), _CT)
HAND_FAIL = ("open_hand", _frames(hand_lm(0.3, 0.5)), _CT)


def answer(face_types, hand_types):
    a = types.SimpleNamespace()
    a.expected_instruction_types = list(face_types)
    a.expected_hand_instruction_types = list(hand_types)
    a.expected_hand_sides = [None] * len(hand_types)
    a.expected_fingers = [None] * len(hand_types)
    a.tolerance_sec = 0.6
    return a


def fbd(face_list, hand_list, face_rids=None, hand_rids=None) -> dict:
    fi = []
    for k, (t, fr, c) in enumerate(face_list):
        d = {"type": t, "completed_at_t": c, "frames": fr}
        if face_rids is not None:
            d["round_id"] = face_rids[k]
        fi.append(d)
    hi = []
    for k, (t, fr, c) in enumerate(hand_list):
        d = {"type": t, "hand": None, "completed_at_t": c, "frames": fr}
        if hand_rids is not None:
            d["round_id"] = hand_rids[k]
        hi.append(d)
    return {
        "evidence_version": 1, "frame_w": 480, "frame_h": 480,
        "face_evidence": {"instructions": fi},
        "hand_evidence": {"instructions": hi},
    }


class force_face_detected:
    """build_rounds 가 참조하는 모듈 전역 _face_detected 를 일시 스왑(픽스처 없이 standalone 호환)."""
    def __init__(self, value: bool):
        self.value = value

    def __enter__(self):
        self._orig = fda._face_detected
        fda._face_detected = lambda *a, **k: self.value
        return self

    def __exit__(self, *exc):
        fda._face_detected = self._orig


def _decide(a, data):
    return decide_three_round_captcha(build_rounds(a, data))


# ---------------------------------------------------------------------------
# 1. 완화 정책 — 0/1쌍 실패 PASS, 2쌍 실패 FAIL
# ---------------------------------------------------------------------------

def test_three_pairs_pass() -> None:
    a = answer(["smile"] * 3, ["open_hand"] * 3)
    with force_face_detected(True):
        res = _decide(a, fbd([FACE_PASS] * 3, [HAND_PASS] * 3))
    assert res.decision == "PASS"
    assert res.failed_mission_count == 0


def test_one_pair_fail_still_pass() -> None:
    # round0 손 실패 — 1쌍 실패 → total_risk 0.70 < 1.20 → PASS (현재 6미션 AND면 422였던 케이스)
    a = answer(["smile"] * 3, ["open_hand"] * 3)
    with force_face_detected(True):
        res = _decide(a, fbd([FACE_PASS] * 3, [HAND_FAIL, HAND_PASS, HAND_PASS]))
    assert res.decision == "PASS"
    assert res.failed_mission_count == 1
    assert abs(res.total_risk - 0.70) < 1e-9


def test_two_pairs_fail() -> None:
    a = answer(["smile"] * 3, ["open_hand"] * 3)
    with force_face_detected(True):
        res = _decide(a, fbd([FACE_PASS] * 3, [HAND_FAIL, HAND_FAIL, HAND_PASS]))
    assert res.decision == "FAIL"
    assert res.failed_mission_count == 2


# ---------------------------------------------------------------------------
# 2. mission_pass = 얼굴 AND 손 (한쪽만 통과한 쌍은 실패)
# ---------------------------------------------------------------------------

def test_face_pass_hand_fail_round_not_passed() -> None:
    a = answer(["smile"] * 3, ["open_hand"] * 3)
    with force_face_detected(True):
        rounds = build_rounds(a, fbd([FACE_PASS] * 3, [HAND_FAIL, HAND_PASS, HAND_PASS]))
    assert rounds[0].mission_pass is False   # 얼굴 통과 + 손 실패 → 쌍 실패
    assert rounds[1].mission_pass is True
    assert rounds[2].mission_pass is True


def test_hand_pass_face_fail_round_not_passed() -> None:
    a = answer(["smile"] * 3, ["open_hand"] * 3)
    with force_face_detected(True):
        rounds = build_rounds(a, fbd([FACE_FAIL, FACE_PASS, FACE_PASS], [HAND_PASS] * 3))
    assert rounds[0].mission_pass is False   # 손 통과 + 얼굴 실패 → 쌍 실패
    assert rounds[1].mission_pass is True


# ---------------------------------------------------------------------------
# 3. fail-closed
# ---------------------------------------------------------------------------

def test_none_fail_closed() -> None:
    a = answer(["smile"] * 3, ["open_hand"] * 3)
    rounds = build_rounds(a, None)
    assert all(not r.mission_pass for r in rounds)
    assert decide_three_round_captcha(rounds).decision == "FAIL"


def test_parse_error_fail_closed() -> None:
    a = answer(["smile"] * 3, ["open_hand"] * 3)
    rounds = build_rounds(a, {"face_evidence": "malformed"})
    assert decide_three_round_captcha(rounds).decision == "FAIL"


def test_sequence_mismatch_fail_closed() -> None:
    # 증거 타입(blink_left)이 expected(smile)와 불일치 → fail-closed
    a = answer(["smile"] * 3, ["open_hand"] * 3)
    bad = fbd([("blink_left", _frames(smile_lm(5.0)), _CT)] * 3, [HAND_PASS] * 3)
    assert decide_three_round_captcha(build_rounds(a, bad)).decision == "FAIL"


def test_empty_expected_hand_fail_closed() -> None:
    # C-0: 빈 expected_hand → fail-closed (face-only 자동통과 차단)
    a = answer(["smile"] * 3, [])
    rounds = build_rounds(a, fbd([FACE_PASS] * 3, []))
    assert all(not r.mission_pass for r in rounds)
    assert decide_three_round_captcha(rounds).decision == "FAIL"


# ---------------------------------------------------------------------------
# 4. 라운드 매핑 — positional 결정성 / round_id forward-compat
# ---------------------------------------------------------------------------

def test_positional_mapping_deterministic() -> None:
    # 얼굴 실패 idx0, 손 실패 idx1 → positional 쌍 → 라운드0,1 실패(2쌍) → FAIL
    a = answer(["smile"] * 3, ["open_hand"] * 3)
    data = fbd([FACE_FAIL, FACE_PASS, FACE_PASS], [HAND_PASS, HAND_FAIL, HAND_PASS])
    with force_face_detected(True):
        rounds = build_rounds(a, data)
    assert [r.mission_pass for r in rounds] == [False, False, True]
    assert decide_three_round_captcha(rounds).decision == "FAIL"


def test_round_id_forward_compat() -> None:
    # round_id 부여 + 손 리스트를 round_id로 역순 → round_id 기준 그룹핑 확인.
    # 손 round_id [2,1,0] 이므로 round_id 0 의 손 = hand_insts[2] = HAND_FAIL.
    a = answer(["smile"] * 3, ["open_hand"] * 3)
    data = fbd([FACE_PASS] * 3, [HAND_PASS, HAND_PASS, HAND_FAIL],
               face_rids=[0, 1, 2], hand_rids=[2, 1, 0])
    with force_face_detected(True):
        rounds = build_rounds(a, data)
    by_rid = {r.round_id: r for r in rounds}
    assert by_rid[0].mission_pass is False   # face[0] + hand(rid0)=hand_insts[2] FAIL
    assert by_rid[1].mission_pass is True
    assert by_rid[2].mission_pass is True


# ---------------------------------------------------------------------------
# 5. spoof=0.0 → real_safe, risk 계산 / face_detected 게이트
# ---------------------------------------------------------------------------

def test_spoof_zero_real_safe_risk() -> None:
    a = answer(["smile"] * 3, ["open_hand"] * 3)
    with force_face_detected(True):
        rounds = build_rounds(a, fbd([FACE_PASS] * 3, [HAND_FAIL, HAND_PASS, HAND_PASS]))
        res = decide_three_round_captcha(rounds)
    assert all(r.spoof_score == 0.0 for r in rounds)
    assert res.risk_bands == ["real_safe", "real_safe", "real_safe"]
    assert res.spoof_detected_count == 0
    assert abs(res.total_risk - 0.70) < 1e-9


def test_face_detected_gate_empty_frames() -> None:
    # build_x_seq_from_evidence([], ...) → None → face_detected False (게이트 단위 검증, 스왑 없음)
    inst = types.SimpleNamespace(frames=[])
    assert fda._face_detected(inst, 480, 480) is False


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
