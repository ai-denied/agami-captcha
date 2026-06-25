"""
Face Liveness Inference HTTP Client (관찰 단계)
================================================
A2 ``check_face_evidence`` 가 verdict 를 결정하고 ``baseline_verdict(hit)`` 으로
응답이 산출된 뒤, **관찰용** 으로 face-liveness-api 의 ``/api/v1/predict`` 를
호출해 ``spoof_score`` 를 로그에만 기록한다. **verdict 에는 영향을 주지 않는다**.

분포 검증 전 단계라 fail-closed 가 아니다 — 추출/예측 실패는 모두 흡수하고
None 을 반환하며 호출처(``public.py``)에서 ``logger.warning`` 만 남긴다.

구조 차용: ``inference_client.py`` (flashlight) 의 ``httpx.AsyncClient + base_url
+ raise_for_status`` 패턴을 그대로 따른다. flashlight 의 ``bot_risk_score`` 대신
face-liveness 응답의 ``spoof_score`` / ``risk_band`` / ``is_spoof`` 를 파싱한다.

좌표 공간: 위젯이 raw 정규화(0~1) 그대로 보낸 랜드마크를
``FaceFeatureExtractor.extract_from_landmarks`` 로 (16, 20) ``x_seq`` 로 환산한다
(fi_eff velocity 보정 · 종횡비 보정 · 16프레임 보간 모두 추출기 내장).
"""

from __future__ import annotations

import logging
from typing import Any

import httpx
import numpy as np

from app.captcha.face_evidence import FaceEvidenceFrame
from app.captcha.face_feature_extractor import FaceFeatureExtractor
from app.core.config import get_settings

logger = logging.getLogger(__name__)

_PREDICT_PATH = "/api/v1/predict"

__all__ = [
    "build_x_seq_from_evidence",
    "predict_face_spoof",
]


# FaceFeatureExtractor 는 상태가 없으므로 모듈 1회 생성 후 재사용한다(요청마다
# 생성 금지). extract_from_landmarks 경로만 사용하므로 mediapipe / cv2 의 lazy
# init 은 발동하지 않는다 — 추출기 모듈은 numpy 만 임포트한다.
_extractor = FaceFeatureExtractor(target_frames=16)


def build_x_seq_from_evidence(
    frames: list[FaceEvidenceFrame],
    frame_w: int,
    frame_h: int,
) -> tuple[np.ndarray, int, dict] | None:
    """A2 ``FaceEvidenceFrame`` 리스트를 ``extract_from_landmarks`` 입력으로
    변환한 뒤 ``(x_seq, seq_length, info)`` 를 반환한다.

    A2 의 landmarks 는 ``dict[str, [x, y]]`` (위젯이 JSON 직렬화하며 키가 문자열
    이 된다). 추출기는 ``dict[int, [x, y]]`` 를 기대하므로 키를 ``int`` 로 환산한다.
    좌표값 자체는 raw 정규화 그대로 — 환산/뒤집기 없음.

    Args:
        frames: 단일 instruction 의 프레임 시계열(A2 FaceEvidence).
        frame_w / frame_h: 클립 단위 캡처 해상도(현재 위젯은 480x480 고정).
            정사각형이면 종횡비 보정이 항등이지만 추출기 API 가 항상 요구한다.

    Returns:
        성공: ``(x_seq[shape=(16,20)], seq_length:int, info:dict)``.
        실패(빈 frames / 예외): ``None`` (관찰 단계 — verdict 무관 흡수).
    """
    try:
        if not frames:
            return None
        # str 키 → int 키 환산. 값(=[x, y])은 그대로(raw 정규화 0~1).
        landmarks_list: list[dict[int, list[float]] | None] = [
            {int(k): v for k, v in f.landmarks.items()} for f in frames
        ]
        timestamps_ms = [float(f.t) for f in frames]
        n = len(frames)
        widths = [float(frame_w)] * n
        heights = [float(frame_h)] * n
        x_seq, seq_length, info = _extractor.extract_from_landmarks(
            landmarks_list,
            timestamps_ms=timestamps_ms,
            widths=widths,
            heights=heights,
        )
        return x_seq, seq_length, info
    except Exception:
        logger.warning("face feature extraction failed (observe-only)", exc_info=True)
        return None


async def predict_face_spoof(
    x_seq: np.ndarray,
    seq_length: int,
) -> dict | None:
    """face-liveness-api ``/api/v1/predict`` 호출 — 관찰 단계.

    실패(예외 / 비200 / 타임아웃 / 응답 키 누락)는 모두 ``None`` 으로 흡수한다.
    호출처(``public.py``)는 None 도 정상 로그 케이스로 처리하고 verdict 에는
    영향을 주지 않는다(분포 검증 전 단계).

    Args:
        x_seq: ``(16, 20)`` ``np.float32`` — extract_from_landmarks 결과.
        seq_length: 실제 유효 프레임 수.

    Returns:
        성공: ``{"spoof_score": float|None, "risk_band": str|None, "is_spoof": bool|None}``
            (face-liveness 응답에서 각 키를 그대로 ``.get`` — 없으면 None).
        실패: ``None``.
    """
    settings = get_settings()
    try:
        payload: dict[str, Any] = {
            "x_seq": x_seq.tolist(),
            "seq_length": int(seq_length),
        }
        async with httpx.AsyncClient(
            base_url=settings.face_liveness_api_url,
            timeout=settings.inference_timeout_sec,
        ) as client:
            resp = await client.post(_PREDICT_PATH, json=payload)
            resp.raise_for_status()
            data = resp.json()
        return {
            "spoof_score": data.get("spoof_score"),
            "risk_band": data.get("risk_band"),
            "is_spoof": data.get("is_spoof"),
        }
    except Exception:
        logger.warning("face liveness inference failed (observe-only)", exc_info=True)
        return None
