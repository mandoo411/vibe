/**
 * OAuth 1.0a HMAC-SHA1 서명 (X/Twitter API v2 트윗 작성용)
 * 외부 라이브러리 없이 Node 내장 crypto만 사용
 */
import crypto from "node:crypto";

function percentEncode(str) {
  return encodeURIComponent(str).replace(/[!*'()]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
}

function buildSignatureBaseString(method, url, params) {
  const sortedParams = Object.keys(params)
    .sort()
    .map((k) => `${percentEncode(k)}=${percentEncode(params[k])}`)
    .join("&");
  return [method.toUpperCase(), percentEncode(url), percentEncode(sortedParams)].join("&");
}

function buildSigningKey(consumerSecret, tokenSecret) {
  return `${percentEncode(consumerSecret)}&${percentEncode(tokenSecret)}`;
}

export function getOAuth1Header(method, url, extraParams = {}) {
  const oauthParams = {
    oauth_consumer_key: process.env.TWITTER_API_KEY,
    oauth_nonce: crypto.randomBytes(16).toString("hex"),
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: Math.floor(Date.now() / 1000).toString(),
    oauth_token: process.env.TWITTER_ACCESS_TOKEN,
    oauth_version: "1.0",
  };

  const allParams = { ...oauthParams, ...extraParams };
  const baseString = buildSignatureBaseString(method, url, allParams);
  const signingKey = buildSigningKey(process.env.TWITTER_API_SECRET, process.env.TWITTER_ACCESS_SECRET);
  const signature = crypto.createHmac("sha1", signingKey).update(baseString).digest("base64");

  const headerParams = { ...oauthParams, oauth_signature: signature };
  return (
    "OAuth " +
    Object.keys(headerParams)
      .sort()
      .map((k) => `${percentEncode(k)}="${percentEncode(headerParams[k])}"`)
      .join(", ")
  );
}
