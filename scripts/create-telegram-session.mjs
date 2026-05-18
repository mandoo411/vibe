import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import input from "input";

const apiId = parseInt(process.env.TELEGRAM_API_ID);
const apiHash = process.env.TELEGRAM_API_HASH;
const session = new StringSession("");

const client = new TelegramClient(session, apiId, apiHash, {
  connectionRetries: 5,
});

await client.start({
  phoneNumber: async () => await input.text("전화번호 입력 (+8210xxxx): "),
  password: async () => await input.text("2단계 비밀번호 (없으면 엔터): "),
  phoneCode: async () => await input.text("텔레그램 인증코드 입력: "),
  onError: (err) => console.log(err),
});

console.log("✅ 세션 문자열 (GitHub Secret에 저장하세요):");
console.log(client.session.save());

await client.disconnect();
