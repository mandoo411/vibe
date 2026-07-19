/**
 * Meta Graph API — 인스타그램 캐러셀(5장) 포스팅
 * 전제: 인스타그램 비즈니스/크리에이터 계정 + 연결된 Facebook 페이지 필요.
 * 전제: Graph API는 이미지를 "공개 URL"로만 읽는다 — 로컬 PNG를 직접 업로드할 수 없어서,
 *       generated/ 에 렌더링한 이미지를 이 저장소에 커밋·푸시한 뒤
 *       raw.githubusercontent.com URL을 넘겨준다 (repo가 public이어야 함).
 */
const GRAPH_VERSION = "v21.0";
const GRAPH_BASE = `https://graph.facebook.com/${GRAPH_VERSION}`;

async function graphPost(path, params) {
  const res = await fetch(`${GRAPH_BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params).toString(),
  });
  const data = await res.json();
  if (!res.ok || data.error) throw new Error(`Graph API 오류: ${JSON.stringify(data.error || data)}`);
  return data;
}

async function graphGet(path, params) {
  const qs = new URLSearchParams(params).toString();
  const res = await fetch(`${GRAPH_BASE}${path}?${qs}`);
  const data = await res.json();
  if (!res.ok || data.error) throw new Error(`Graph API 오류: ${JSON.stringify(data.error || data)}`);
  return data;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * 미디어 컨테이너(단일 이미지든 캐러셀이든)는 생성 직후 바로 게시할 수 없다 —
 * Meta가 이미지를 다운로드·처리하는 데 몇 초~수십 초가 걸리고, status_code가
 * FINISHED가 되기 전에 media_publish를 부르면 "Media ID is not available"(코드 9007)로 실패한다.
 * status_code가 FINISHED가 될 때까지 폴링하고, ERROR/EXPIRED면 즉시 에러를 던진다.
 */
async function waitUntilFinished(containerId, accessToken, { maxAttempts = 15, intervalMs = 3000 } = {}) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const { status_code } = await graphGet(`/${containerId}`, {
      fields: "status_code",
      access_token: accessToken,
    });
    if (status_code === "FINISHED") return;
    if (status_code === "ERROR" || status_code === "EXPIRED") {
      throw new Error(`미디어 컨테이너 처리 실패 (id=${containerId}, status=${status_code})`);
    }
    // IN_PROGRESS 등 — 대기 후 재시도
    await sleep(intervalMs);
  }
  throw new Error(`미디어 컨테이너 처리 시간 초과 (id=${containerId})`);
}

function publicImageUrl(fileName) {
  const repo = process.env.GITHUB_REPOSITORY || "mandoo411/vibe";
  // 수동 workflow_dispatch를 다른 브랜치에서 실행했을 때, 발행 이미지가 실제로 렌더링된
  // 브랜치가 아니라 항상 main에서만 읽혀서 최신 렌더와 발행 결과가 어긋나는 버그가 있었다.
  // GITHUB_REF_NAME(Actions가 자동 제공)을 우선 사용해 "실행 중인 브랜치"의 이미지를 읽도록 한다.
  const branch = process.env.PROMO_ASSET_BRANCH || process.env.GITHUB_REF_NAME || "main";
  return `https://raw.githubusercontent.com/${repo}/${branch}/generated/${fileName}`;
}

/** imageFileNames: repo generated/ 폴더에 이미 커밋·푸시된 파일명 배열 */
export async function postInstagramCarousel(imageFileNames, caption) {
  const accessToken = process.env.META_ACCESS_TOKEN;
  const igUserId = process.env.INSTAGRAM_ACCOUNT_ID;

  const childIds = [];
  for (const fileName of imageFileNames) {
    const item = await graphPost(`/${igUserId}/media`, {
      image_url: publicImageUrl(fileName),
      is_carousel_item: "true",
      access_token: accessToken,
    });
    await waitUntilFinished(item.id, accessToken);
    childIds.push(item.id);
  }

  const carousel = await graphPost(`/${igUserId}/media`, {
    media_type: "CAROUSEL",
    children: childIds.join(","),
    caption,
    access_token: accessToken,
  });
  await waitUntilFinished(carousel.id, accessToken);

  return graphPost(`/${igUserId}/media_publish`, {
    creation_id: carousel.id,
    access_token: accessToken,
  });
}
