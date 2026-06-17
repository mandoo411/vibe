# 외부 크론(cron-job.org)으로 Daily Market Sync 트리거하기

GitHub Actions의 `schedule:` cron은 러너 부하에 따라 수 분~수십 분 지연될 수 있습니다.
마감시황을 정시(매일 17:00 KST)에 안정적으로 돌리기 위해 **cron-job.org** 같은 외부 스케줄러로
GitHub `repository_dispatch` API를 직접 호출합니다.

대상 워크플로: `.github/workflows/daily-market-sync.yml`
이 워크플로에는 다음 트리거가 설정되어 있습니다.

- `schedule` (백업용 자동 실행)
- `workflow_dispatch` (수동 실행)
- `repository_dispatch` (`types: [trigger-daily-market]`) ← **외부 트리거용**

## cron-job.org 설정 방법

1. **cron-job.org 가입** — https://cron-job.org
2. **새 크론잡 생성** (Create cronjob)
3. **URL**
   ```
   https://api.github.com/repos/mandoo411/vibe/dispatches
   ```
4. **Method**: `POST`
5. **Headers**
   ```
   Authorization: Bearer {GITHUB_TOKEN}
   Content-Type: application/json
   Accept: application/vnd.github.v3+json
   ```
6. **Body (Request body)**
   ```json
   {"event_type": "trigger-daily-market"}
   ```
7. **실행 시간**: 매일 **17:00 KST (08:00 UTC)**
   - cron-job.org 스케줄을 KST로 설정하거나, UTC 기준이면 `08:00`으로 설정.
8. **GitHub Token 발급**
   - GitHub → Settings → Developer settings → Personal access tokens
   - **Classic 토큰**이면 `repo` scope 권한으로 발급.
   - **Fine-grained 토큰**이면 대상 리포지토리(`mandoo411/vibe`)에 대해
     `Contents: Read and write` + `Actions: Read and write` 권한 부여.
   - 발급한 토큰을 위 `Authorization: Bearer {GITHUB_TOKEN}` 자리에 넣습니다.

## 동작 확인

- cron-job.org에서 수동 실행(Run now) 후, GitHub → Actions → **Daily Market Sync** 실행 목록에
  `repository_dispatch` 이벤트로 새 실행이 생기는지 확인합니다.
- API가 정상이면 HTTP `204 No Content`를 반환합니다(응답 본문 없음).

## curl 테스트 (선택)

```bash
curl -X POST \
  -H "Authorization: Bearer ${GITHUB_TOKEN}" \
  -H "Accept: application/vnd.github.v3+json" \
  -H "Content-Type: application/json" \
  https://api.github.com/repos/mandoo411/vibe/dispatches \
  -d '{"event_type":"trigger-daily-market"}'
```

## 참고

- 토큰은 절대 리포지토리에 커밋하지 마세요. cron-job.org의 헤더 설정에만 보관합니다.
- `schedule` 트리거는 백업으로 남겨두면, 외부 크론이 실패해도 GitHub 자체 스케줄로 한 번 더 실행됩니다.
