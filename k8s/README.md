# K8s Manifests (agami-captcha)

namespace `agami` 배포 manifest. ArgoCD GitOps 디렉토리 sync 대상.

## 리소스 목록

| 파일 | Kind | name | 비고 |
|---|---|---|---|
| `01-configmap.yaml` | ConfigMap | `captcha-config` | 앱 환경변수 |
| `02-deployment.yaml` | Deployment | `captcha-api` | FastAPI 백엔드 (GPU 노드) |
| `03-redis-deployment.yaml` | Deployment | `redis` | Redis 7-alpine |
| `04-service.yaml` | Service | `captcha-api` | ClusterIP 8000 |
| `05-ingress.yaml` | Ingress | `agami-captcha-ingress` | Traefik, host `agami-captcha.cloud` |
| `secret.example.yaml` | Secret (template) | `captcha-app-secret` | **placeholder만 — sync 제외 필수** |

## ⚠️ ArgoCD sync 화이트리스트 (필수)

`secret.example.yaml` 와 `README.md` 가 sync 되지 않도록 Application 에서 반드시 화이트리스트를 지정:

```yaml
spec:
  source:
    directory:
      include: '[0-9][0-9]-*.yaml'
```

이 설정이 없으면 ArgoCD 가 `secret.example.yaml` 도 적용 → 실 `captcha-app-secret` 을 `<REPLACE_ME>` 로 **덮어써 운영 장애**.

## 시크릿 관리 (git 미포함, 수동)

### captcha-app-secret (앱 시크릿)

`secret.example.yaml` 의 placeholder 를 실값으로 교체해 클러스터에 직접 적용:

```bash
cp secret.example.yaml /tmp/secret.yaml
# /tmp/secret.yaml 의 <REPLACE_ME> 를 실값으로 교체
kubectl apply -f /tmp/secret.yaml
rm /tmp/secret.yaml
```

키 설명:
- **DATABASE_URL** — 외부 Postgres 연결 문자열 (`postgresql://user:pass@host:5432/db`)
- **API_KEY_HMAC_PEPPER** (hex32) — **재생성 금지**. 변경 시 발급된 모든 API 키 무효화.
- **CAPTCHA_TOKEN_SECRET** (hex32) — **재생성 금지**. 변경 시 발급된 모든 캡챠 토큰 무효화.

실값 백업: Master VM `~/.captcha-secrets-backup` (mode 600).

### harbor-creds (이미지 pull)

```bash
kubectl create secret docker-registry harbor-creds \
  --docker-server=agami-captcha.cloud:8443 \
  --docker-username=<USER> --docker-password=<PW> \
  -n agami
```

### agami-web-tls (ingress TLS)

Ingress `tls.secretName` 이 참조하는 인증서 secret. cert-manager 자동 발급 또는 기존 운영 secret 재사용. **이 repo 관리 대상 아님** (참조만).

## 이미지 태그 정책

- **현재**: 수동 `v1.0.x` 태그, `imagePullPolicy: Always` (동일 태그 재배포 시 캐시 회피)
- **향후 (M4)**: Jenkins CI 타임스탬프 태그 + ArgoCD 자동 sync

## 적용 순서 (수동 설치 시 참고)

ArgoCD 가 의존성을 자동 처리하지만, 수동 적용 시:

1. namespace: `kubectl create ns agami` (없으면)
2. ConfigMap: `01-configmap.yaml`
3. Secret (수동): `harbor-creds`, `captcha-app-secret`, `agami-web-tls`
4. Deployments: `03-redis-deployment.yaml`, `02-deployment.yaml`
5. Service: `04-service.yaml`
6. Ingress: `05-ingress.yaml`
