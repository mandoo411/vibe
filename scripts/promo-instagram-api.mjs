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

function publicImageUrl(fileName) {
  const repo = process.env.GITHUB_REPOSITORY || "mandoo411/vibe";
  const branch = process.env.PROMO_ASSET_BRANCH || "main";
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
    childIds.push(item.id);
  }

  const carousel = await graphPost(`/${igUserId}/media`, {
    media_type: "CAROUSEL",
    children: childIds.join(","),
    caption,
    access_token: accessToken,
  });

  return graphPost(`/${igUserId}/media_publish`, {
    creation_id: carousel.id,
    access_token: accessToken,
  });
}
