# 간단 계산기 (Vercel 배포용)

정적(Static) 웹 계산기입니다. `index.html`을 그대로 Vercel에 배포할 수 있게 구성했습니다.

## 로컬 실행

- **그냥 실행**: `index.html`을 브라우저로 열기
- **Vercel 미리보기(권장)**:

```bash
npm run dev
```

## Vercel 배포

### 1) GitHub로 올린 뒤, Vercel에서 Import

- GitHub에 이 폴더를 리포지토리로 푸시
- Vercel 대시보드에서 **New Project → Import Git Repository**
- Framework는 자동(Static)으로 잡히며, 빌드 설정 변경 없이 배포됩니다.

### 2) Vercel CLI로 배포

```bash
npx --yes vercel@53.2.0 login
npx --yes vercel@53.2.0
npx --yes vercel@53.2.0 --prod
```

## 파일 구성

- `index.html`: 화면/UI
- `style.css`: 스타일
- `script.js`: 계산 로직
- `vercel.json`: 정적 배포 라우팅 설정

