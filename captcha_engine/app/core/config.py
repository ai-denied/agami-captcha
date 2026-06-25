"""
Application Settings
====================
WBS #42: 환경변수 기반 설정.

Pydantic v2 의 pydantic-settings 패키지 사용.
운영/개발 환경 분리는 환경변수로 (.env 또는 K8s Secret).

설치: pip install pydantic-settings
"""

from __future__ import annotations

from functools import lru_cache

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        case_sensitive=False,
        extra="ignore",
    )

    # -----------------------------------------------------------------------
    # 일반
    # -----------------------------------------------------------------------
    app_env: str = Field(default="local", description="local | dev | prod")
    log_level: str = Field(default="INFO")

    # -----------------------------------------------------------------------
    # PostgreSQL
    # -----------------------------------------------------------------------
    # SQLAlchemy 비동기 드라이버: postgresql+asyncpg://...
    database_url: str = Field(
        default="postgresql+asyncpg://captcha:captcha@localhost:5432/captcha"
    )
    db_pool_size: int = Field(default=10)
    db_max_overflow: int = Field(default=10)

    # -----------------------------------------------------------------------
    # Redis
    # -----------------------------------------------------------------------
    redis_url: str = Field(default="redis://localhost:6379/0")
    redis_max_connections: int = Field(default=50)

    # -----------------------------------------------------------------------
    # 보안
    # -----------------------------------------------------------------------
    # API secret_key 검증용 HMAC pepper. Tenant-independent. 주기적 회전 권장.
    # 절대 git 에 커밋 X. K8s Secret / KMS 사용.
    api_key_hmac_pepper: str = Field(default="CHANGE_ME_IN_PRODUCTION")

    # captcha_token (사용자에게 발급되는 1회용 토큰) 의 HMAC 서명 키.
    # api_key_hmac_pepper 와 별도로 분리 (책임 분리, 회전 주기 다를 수 있음).
    captcha_token_secret: str = Field(default="CHANGE_ME_TOKEN_SECRET")

    # Firebase Admin SDK credentials (service account JSON 경로 또는 inline JSON)
    firebase_credentials_path: str | None = Field(default=None)

    # agamidb 가 발급한 로그인 사용자 JWT(HS256) 검증용. agamidb 와 공유하는 비밀키.
    # 캡챠 파드에는 agami-env-secret 의 secretKeyRef(JWT_SECRET_KEY)로 주입됨.
    # 미설정(None)이어도 앱은 기동하고, get_current_user_id 의존성 호출 시에만 503.
    jwt_secret_key: str | None = Field(default=None)
    # 디코드 시 허용할 알고리즘. HS256 고정 (alg 혼동/none 공격 차단).
    jwt_algorithm: str = Field(default="HS256")

    # -----------------------------------------------------------------------
    # 캡챠 동작 정책
    # -----------------------------------------------------------------------
    # Tenant 가 별도 설정을 안 했을 때의 기본값
    default_difficulty: str = Field(default="medium")
    default_rate_limit_per_min: int = Field(default=60)

    # -----------------------------------------------------------------------
    # 손전등 추론 마이크로서비스 (flashlight-inference-api-svc)
    # -----------------------------------------------------------------------
    # 봇 위험도 추론을 컨테이너 내부 ONNX 대신 같은 클러스터의 HTTP 서비스로 위임.
    # K8s 에서는 captcha-config ConfigMap 의 INFERENCE_API_URL 로 주입(case-insensitive).
    inference_api_url: str = Field(default="http://flashlight-inference-api-svc")
    # 추론 API 호출 타임아웃(초). 초과 시 fail-closed(block). face-liveness 도 공유.
    inference_timeout_sec: float = Field(default=5.0)

    # -----------------------------------------------------------------------
    # 안면 라이브니스 추론 마이크로서비스 (face-liveness-api-svc)
    # -----------------------------------------------------------------------
    # 관찰 단계 — A2 hit 이 verdict 를 결정한다. 본 API 의 spoof_score 는 로그에만
    # 기록되며 검증 결과에 영향을 주지 않는다(분포 검증 후 정책 반영 예정).
    # timeout 은 flashlight 와 공용(inference_timeout_sec).
    face_liveness_api_url: str = Field(
        default="http://face-liveness-api-svc.agami.svc.cluster.local"
    )

    # -----------------------------------------------------------------------
    # CORS
    # -----------------------------------------------------------------------
    # 콤마로 구분된 origin 문자열. K8s ConfigMap 에서 한 줄로 주입하기 쉽게 string.
    # 예: "http://localhost:5173,http://210.109.53.140"
    cors_origins: str = Field(default="http://localhost:5173")

    @property
    def cors_origins_list(self) -> list[str]:
        """CORSMiddleware 의 allow_origins 에 직접 넘길 수 있는 list."""
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]

    # -----------------------------------------------------------------------
    # 관리 콘솔 (origin 면제)
    # -----------------------------------------------------------------------
    # 관리 콘솔(agami-captcha.cloud) 내부의 "프로젝트 API 테스트" 호출은 회원이 등록한
    # 도메인과 무관하게 origin 검사를 면제한다. 정확히 이 origin 하나(루트, https)만.
    # 환경이 다르면 env CONSOLE_SELF_ORIGIN 으로 override.
    console_self_origin: str = Field(default="https://agami-captcha.cloud")


@lru_cache
def get_settings() -> Settings:
    """싱글턴 캐시. FastAPI Depends 에서 사용."""
    return Settings()
