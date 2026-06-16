import { defineConfig } from 'vite'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

// =============================================================================
// loader.js 전용 빌드 설정 (Stage 2)
// -----------------------------------------------------------------------------
// - 바닐라 IIFE 빌드. 단일 전역 window.agami 만 노출.
// - 출력 파일명은 해시 없는 고정 이름 'loader.js' (URL 고정용).
// - 출력 디렉터리는 기존 위젯 빌드(npm run build)와 동일한 'dist'.
//   emptyOutDir:false 로 위젯 산출물을 지우지 않고 loader.js 만 추가한다.
//   → Dockerfile.prod 가 dist 를 /app/static/widget 로 복사 → /widget/loader.js 서빙.
//   (실제 Docker 빌드 배선은 Stage 5. 여기서는 경로만 맞춘다.)
// - React/의존성 번들 없음(순수 바닐라). 별도 external 불필요.
//
// 빌드: npm run build:loader   (기존 build 스크립트와 분리)
// =============================================================================
const here = dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  build: {
    outDir: 'dist',
    emptyOutDir: false, // 위젯 빌드 산출물 보존
    lib: {
      entry: resolve(here, 'loader/loader.js'),
      name: 'agami', // IIFE 전역 이름 → window.agami
      formats: ['iife'],
      fileName: () => 'loader.js',
    },
    // minify/target 은 기본값 사용(이 Vite 는 Rolldown 기본 minifier). esbuild 강제 금지.
  },
})
