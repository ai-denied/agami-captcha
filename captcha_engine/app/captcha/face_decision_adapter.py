"""
face_mission 쌍 구조 누적 판정 어댑터 (Phase 3, 갈래A)
=====================================================
위젯이 1회 제출한 evidence(얼굴 instruction 3 + 손 instruction 3)를 captcha_decision.py 의
3개 MissionRound(쌍 구조)로 변환한다. 라운드 i = 얼굴 미션 i + 손 미션 i 한 쌍.

- mission_pass_i = (얼굴 미션 i 통과) AND (손 미션 i 통과)
  · 얼굴: face_evidence._verify_instruction 재사용(A2 13/13 동결 파일 무수정).
  · 손  : hand_evidence 의 라운드 본문(side + _verify_instruction + finger_pose 가드 +
          _verify_fingers) 재현. check_* 의 ALL 게이트는 우회하고 instruction 별로 판정한다.
- face_detected_i: face_inference_client.build_x_seq_from_evidence → face_detect_rate 게이트.
- spoof_score=0.0(spoof 서비스 미연동), risk_band=None
  → captcha_decision 이 classify_spoof_risk(0.0)=real_safe 로 계산(band risk 0.0).

전 과정 fail-closed: None/파싱오류/시퀀스 불일치/길이≠3/빈 expected → 전 라운드 mission_pass
=False(→ decide_three_round_captcha 가 FAIL). 단일제출 계약과 무관(변환만 한다).

라운드 매핑(round_id forward-compat): evidence instruction 에 round_id 가 모두 있으면 그걸로
그룹핑(3단계 라운드형 위젯 대비), 없으면 positional(현재 위젯) — round i = (face[i], hand[i]).
"""

from __future__ import annotations

import logging

from app.captcha import hand_evidence as hand_ev
from app.captcha.captcha_decision import MissionRound
from app.captcha.face_evidence import (
    FaceEvidence,
    _verify_instruction as _verify_face_instruction,
)
from app.captcha.face_inference_client import build_x_seq_from_evidence

logger = logging.getLogger(__name__)

Window = tuple[int, int]  # face_evidence/hand_evidence 와 동일 정의

# face_detect_rate 가 이 값 미만이면 face_detected=False (빈 화면/저검출 게이트).
FACE_DETECT_MIN_RATE = 0.5
# spoof 서비스 미연동 → 모든 라운드 spoof_score 고정값.
FACE_SPOOF_DEFAULT = 0.0

_ROUND_COUNT = 3


def _fail_closed_rounds(reason: str) -> list[MissionRound]:
    """파싱/게이트 실패 → 전 라운드 실패(=FAIL). fail-closed 의 단일 통로."""
    logger.warning("face_decision_adapter fail-closed: %s", reason)
    return [
        MissionRound(
            round_id=i,
            spoof_score=FACE_SPOOF_DEFAULT,
            mission_pass=False,
            face_detected=False,
            hand_detected=False,
            timeout=False,
            mission_name="fail_closed",
            detail=reason,
            risk_band=None,
        )
        for i in range(_ROUND_COUNT)
    ]


def _face_pass(face_inst, tol_ms: int) -> bool:
    if face_inst.completed_at_t is None:
        return False
    win: Window = (face_inst.completed_at_t - tol_ms, face_inst.completed_at_t + tol_ms)
    return _verify_face_instruction(face_inst, win)


def _hand_pass(hand_inst, tol_ms: int, exp_side, exp_fingers) -> bool:
    """check_hand_evidence 라운드 본문 재현(단일 instruction, ALL 게이트 우회)."""
    if hand_inst.completed_at_t is None:
        return False
    if exp_side is not None and hand_inst.hand != exp_side:
        return False
    win: Window = (hand_inst.completed_at_t - tol_ms, hand_inst.completed_at_t + tol_ms)
    if not hand_ev._verify_instruction(hand_inst, win):
        return False
    # finger_pose 는 손가락 검증이 본체 — fingers 미지정이면 fail-closed(원본과 동일).
    if hand_inst.type == "finger_pose" and not exp_fingers:
        return False
    if exp_fingers:
        if not hand_ev._verify_fingers(hand_inst.frames, exp_fingers, win):
            return False
    return True


def _face_detected(face_inst, frame_w: int, frame_h: int) -> bool:
    built = build_x_seq_from_evidence(face_inst.frames, frame_w, frame_h)
    if built is None:
        return False
    _x_seq, _seq_len, info = built
    return float(info.get("face_detect_rate", 0.0)) >= FACE_DETECT_MIN_RATE


def _pair_rounds(raw: dict, face_insts: list, hand_insts: list):
    """(round_id, face_inst, hand_inst, hand_orig_idx) 3개. round_id 있으면 그룹핑, 없으면 positional.

    hand_orig_idx 는 expected_hand_sides/expected_fingers(제출 hand 순서 정렬) 조회용 —
    round_id 매핑이 순서를 바꿔도 손 instruction 의 기대 side/fingers 를 정확히 맞춘다.
    """
    raw_face = (raw.get("face_evidence") or {}).get("instructions") or []
    raw_hand = (raw.get("hand_evidence") or {}).get("instructions") or []
    have_round_id = (
        len(raw_face) == len(face_insts)
        and len(raw_hand) == len(hand_insts)
        and all(isinstance(d, dict) and d.get("round_id") is not None for d in raw_face)
        and all(isinstance(d, dict) and d.get("round_id") is not None for d in raw_hand)
    )
    if have_round_id:
        face_by_rid = {raw_face[i]["round_id"]: face_insts[i] for i in range(len(face_insts))}
        hand_idx_by_rid = {raw_hand[i]["round_id"]: i for i in range(len(hand_insts))}
        common = sorted(set(face_by_rid) & set(hand_idx_by_rid))
        if len(common) == _ROUND_COUNT:
            return [
                (rid, face_by_rid[rid], hand_insts[hand_idx_by_rid[rid]], hand_idx_by_rid[rid])
                for rid in common
            ]
    # positional fallback (현재 위젯 경로): round i = (face[i], hand[i])
    return [(i, face_insts[i], hand_insts[i], i) for i in range(_ROUND_COUNT)]


def build_rounds(answer, face_behavioral_data: dict | None) -> list[MissionRound]:
    """evidence → 쌍 3개 MissionRound. 전 과정 fail-closed."""
    if face_behavioral_data is None:
        return _fail_closed_rounds("face_behavioral_data is None")
    try:
        ev = FaceEvidence.model_validate(face_behavioral_data)
    except Exception:
        return _fail_closed_rounds("FaceEvidence parse error")
    try:
        env = hand_ev._HandEvidenceEnvelope.model_validate(face_behavioral_data)
    except Exception:
        return _fail_closed_rounds("hand envelope parse error")

    face_insts = list(ev.face_evidence.instructions)
    hand_insts = list(env.hand_evidence.instructions) if env.hand_evidence is not None else []

    expected_face = list(answer.expected_instruction_types)
    # HandInstructionType(str Enum)/str 모두 value 화 (check_hand_evidence 와 동일).
    expected_hand = [getattr(t, "value", t) for t in answer.expected_hand_instruction_types]

    # C-0: 빈 expected(특히 expected_hand) → fail-closed (face-only 자동통과 차단).
    if not expected_face or not expected_hand:
        return _fail_closed_rounds("empty expected (face or hand)")

    # 시퀀스 게이트: 순서·내용·길이 정확히 일치(check_face/hand_evidence 와 동일 기준).
    if [i.type for i in face_insts] != expected_face:
        return _fail_closed_rounds("face sequence mismatch")
    if [i.type for i in hand_insts] != expected_hand:
        return _fail_closed_rounds("hand sequence mismatch")
    if len(face_insts) != _ROUND_COUNT or len(hand_insts) != _ROUND_COUNT:
        return _fail_closed_rounds("instruction count != 3")

    tol_ms = int(answer.tolerance_sec * 1000)
    expected_sides = list(getattr(answer, "expected_hand_sides", None) or [])
    expected_fingers = list(getattr(answer, "expected_fingers", None) or [])

    rounds: list[MissionRound] = []
    for rid, face_inst, hand_inst, hand_idx in _pair_rounds(face_behavioral_data, face_insts, hand_insts):
        exp_side = expected_sides[hand_idx] if hand_idx < len(expected_sides) else None
        exp_fingers = expected_fingers[hand_idx] if hand_idx < len(expected_fingers) else None
        face_ok = _face_pass(face_inst, tol_ms)
        hand_ok = _hand_pass(hand_inst, tol_ms, exp_side, exp_fingers)
        rounds.append(
            MissionRound(
                round_id=rid,
                spoof_score=FACE_SPOOF_DEFAULT,
                mission_pass=(face_ok and hand_ok),   # 핵심: 얼굴 AND 손
                face_detected=_face_detected(face_inst, ev.frame_w, ev.frame_h),
                hand_detected=True,
                timeout=False,
                mission_name=f"{face_inst.type}+{hand_inst.type}",
                risk_band=None,
            )
        )
    return rounds
