# Agami Captcha

AI 기반 캡챠 엔진 — 손전등 캡챠, 얼굴 미션 캡챠, 이미지 그리드 캡챠를 제공하는 SaaS 백엔드 + 위젯 프론트엔드.

## 디렉토리 구조

```
agami-captcha/
├── captcha-frontend/   # React + Vite 위젯 (임베드 가능)
├── captcha_engine/     # FastAPI 백엔드 (Postgres + Redis + ONNX)
├── docs/               # API 명세, 임베드 가이드, 배포 가이드
├── k8s/                # K8s manifest (M3에서 이관 예정 — 현재 비어 있음)
├── .gitignore
├── .dockerignore
└── README.md
```

## 배포/실행 전 준비 (필수)

### 1. 데이터셋 배치

손전등 캡챠는 라벨이 달린 1000장의 이미지 데이터셋을 사용합니다. **이 데이터셋은 Git에 포함되지 않으므로 clone 후 별도 배치해야 합니다.**

- **보관 위치**: 별도 채널 (GPU 서버 또는 사내 zip 공유)
- **배치 경로**:
  - `captcha_engine/app/static/captcha_images/` — 이미지 1000장 (`captcha_0001.jpg` ~ `captcha_1000.jpg`)
  - `captcha_engine/app/static/captcha_labels/` — JSON 라벨 1001개
- **미배치 시 동작**: 앱 시작 시 `RuntimeError("이미지 데이터셋 로드 실패: 0개만 로드됨")` 발생하며 컨테이너가 종료됩니다.

배치 후 Docker 빌드 시 데이터셋은 자동으로 이미지에 포함됩니다 (`.dockerignore`에서 제외하지 않음).

```bash
# 예시: 데이터셋 zip을 받아 풀기
cd captcha_engine/app/static
unzip ~/Downloads/captcha_dataset.zip   # captcha_images/, captcha_labels/ 생성
```

### 2. 환경변수

각 컴포넌트의 템플릿을 복사해 실제 값으로 채웁니다:

- **로컬 개발**: `captcha_engine/.env.example` → `.env`
- **운영 배포**: `captcha_engine/.env.deploy.example` → `.env.deploy`

**모든 placeholder 값(`__set_me__`, `CHANGE_ME_IN_PRODUCTION` 등)은 배포 전에 반드시 실제 값으로 교체해야 합니다.**

운영 시크릿(`API_KEY_HMAC_PEPPER`, `CAPTCHA_TOKEN_SECRET`, `POSTGRES_PASSWORD`)은 K8s Secret 또는 외부 KMS로만 주입하세요. 절대 Git에 커밋하지 마세요.

## 로컬 실행

### Frontend

```bash
cd captcha-frontend
npm install
npm run dev   # http://localhost:5173
```

### Backend (docker compose)

```bash
cd captcha_engine
cp .env.example .env   # 로컬 개발용 더미 값 사용
docker compose up -d   # api:8000, postgres:5432, redis:6379
```

API 헬스 체크: `curl http://localhost:8000/health`

## 운영 배포

| 문서 | 내용 |
|---|---|
| [docs/DEPLOY_K3S.md](docs/DEPLOY_K3S.md) | KakaoCloud K3s 배포 절차 |
| [docs/HTTPS_MIGRATION.md](docs/HTTPS_MIGRATION.md) | HTTP → HTTPS 마이그레이션 체크리스트 |
| [docs/API_SPEC.md](docs/API_SPEC.md) | API 클라이언트 명세 (사이트 통합용) |
| [docs/EMBED_GUIDE.md](docs/EMBED_GUIDE.md) | iframe 임베드 가이드 (사용자 페이지에 위젯 삽입) |
| [docs/test-embed.html](docs/test-embed.html) | 임베드 테스트 페이지 |

## 마이그레이션 로드맵

- **M2 (이번 단계)**: agami_mlops에서 코드 단순 복사 이전 (history 미포함)
- **M3**: K8s manifest 이관 및 정리 (현재 `k8s/`는 빈 폴더)
- **M4+**: CI/CD 파이프라인, 자동 배포

## 보안 주의

- `.env`, `*.pem`, `*-secret.yaml` 등은 절대 Git에 추적 금지 (`.gitignore` 적용 중)
- 운영 시크릿은 K8s Secret 또는 외부 KMS로만 주입
- `docker-compose.yml`의 더미 비밀번호(`securepassword`, `local-pepper-do-not-use-in-prod`)는 로컬 개발 전용
