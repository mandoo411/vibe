/**
 * DART Open API의 corpCode.xml / document.xml 은 ZIP(binary)으로 응답한다.
 * npm 의존성을 추가하면 package-lock.json 전체가 다른 npm 버전 포맷으로 재작성되어
 * 버리기 아까운 diff 노이즈가 생기고(직접 확인함 — 실제 버전 변경은 없이 들여쓰기만
 * 통째로 바뀜), 다른 배치 스크립트의 `npm ci`에도 영향을 줄 수 있어 위험 부담이 크다.
 * DART가 주는 zip은 암호화 없는 표준 스토어/디플레이트 항목뿐이라, Node 내장 zlib
 * (inflateRawSync)만으로 직접 읽는 게 더 안전하다. 아래 파서는 이 파일 하단의
 * selfTest()로 실제 ZIP 스펙에 맞는 바이트를 직접 만들어 왕복 검증한다.
 */
import zlib from "node:zlib";

/** ZIP 파일(Buffer)을 읽어 { [entryName]: Buffer } 형태로 반환.
 * End Of Central Directory(EOCD)에서 중앙 디렉터리를 찾고, 각 항목의 로컬 파일
 * 헤더를 직접 따라가며 압축 방식(0=저장, 8=deflate)에 따라 압축을 푼다. */
export function readZipEntries(buf) {
  if (!Buffer.isBuffer(buf)) throw new Error("readZipEntries: Buffer가 아님");

  const EOCD_SIG = 0x06054b50;
  const searchStart = Math.max(0, buf.length - 65557);
  let eocdOffset = -1;
  for (let i = buf.length - 22; i >= searchStart; i -= 1) {
    if (buf.readUInt32LE(i) === EOCD_SIG) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset === -1) throw new Error("readZipEntries: EOCD 시그니처를 찾을 수 없음 (zip 형식 아님)");

  const totalEntries = buf.readUInt16LE(eocdOffset + 10);
  const cdOffset = buf.readUInt32LE(eocdOffset + 16);

  const entries = {};
  let ptr = cdOffset;
  const CD_SIG = 0x02014b50;
  for (let i = 0; i < totalEntries; i += 1) {
    const sig = buf.readUInt32LE(ptr);
    if (sig !== CD_SIG) throw new Error(`readZipEntries: 중앙 디렉터리 시그니처 불일치 (idx=${i})`);
    const method = buf.readUInt16LE(ptr + 10);
    const compSize = buf.readUInt32LE(ptr + 20);
    const nameLen = buf.readUInt16LE(ptr + 28);
    const extraLen = buf.readUInt16LE(ptr + 30);
    const commentLen = buf.readUInt16LE(ptr + 32);
    const localHeaderOffset = buf.readUInt32LE(ptr + 42);
    const name = buf.toString("utf8", ptr + 46, ptr + 46 + nameLen);
    ptr += 46 + nameLen + extraLen + commentLen;

    const LFH_SIG = 0x04034b50;
    if (buf.readUInt32LE(localHeaderOffset) !== LFH_SIG) {
      throw new Error(`readZipEntries: 로컬 파일 헤더 시그니처 불일치 (entry=${name})`);
    }
    const lfhNameLen = buf.readUInt16LE(localHeaderOffset + 26);
    const lfhExtraLen = buf.readUInt16LE(localHeaderOffset + 28);
    const dataStart = localHeaderOffset + 30 + lfhNameLen + lfhExtraLen;
    const raw = buf.subarray(dataStart, dataStart + compSize);

    let content;
    if (method === 0) content = Buffer.from(raw);
    else if (method === 8) content = zlib.inflateRawSync(raw);
    else throw new Error(`readZipEntries: 지원하지 않는 압축 방식 method=${method} (entry=${name})`);

    entries[name] = content;
  }
  return entries;
}

function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) {
    crc ^= buf[i];
    for (let j = 0; j < 8; j += 1) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function buildZip(entryName, originalBuf, compressedBuf, method) {
  const nameBuf = Buffer.from(entryName, "utf8");
  const crc = crc32(originalBuf);

  const lfh = Buffer.alloc(30);
  lfh.writeUInt32LE(0x04034b50, 0);
  lfh.writeUInt16LE(20, 4);
  lfh.writeUInt16LE(0, 6);
  lfh.writeUInt16LE(method, 8);
  lfh.writeUInt16LE(0, 10);
  lfh.writeUInt16LE(0, 12);
  lfh.writeUInt32LE(crc, 14);
  lfh.writeUInt32LE(compressedBuf.length, 18);
  lfh.writeUInt32LE(originalBuf.length, 22);
  lfh.writeUInt16LE(nameBuf.length, 26);
  lfh.writeUInt16LE(0, 28);

  const cd = Buffer.alloc(46);
  cd.writeUInt32LE(0x02014b50, 0);
  cd.writeUInt16LE(20, 4);
  cd.writeUInt16LE(20, 6);
  cd.writeUInt16LE(0, 8);
  cd.writeUInt16LE(method, 10);
  cd.writeUInt16LE(0, 12);
  cd.writeUInt16LE(0, 14);
  cd.writeUInt32LE(crc, 16);
  cd.writeUInt32LE(compressedBuf.length, 20);
  cd.writeUInt32LE(originalBuf.length, 24);
  cd.writeUInt16LE(nameBuf.length, 28);
  cd.writeUInt16LE(0, 30);
  cd.writeUInt16LE(0, 32);
  cd.writeUInt16LE(0, 34);
  cd.writeUInt16LE(0, 36);
  cd.writeUInt32LE(0, 38);
  cd.writeUInt32LE(0, 42);

  const cdOffset = lfh.length + nameBuf.length + compressedBuf.length;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(cd.length + nameBuf.length, 12);
  eocd.writeUInt32LE(cdOffset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([lfh, nameBuf, compressedBuf, cd, nameBuf, eocd]);
}

export function selfTest() {
  const original = Buffer.from("<주주총회> 일시: 2026년 10월 30일 오전 9시</주주총회>", "utf8");

  const zipStored = buildZip("test.xml", original, original, 0);
  const entries1 = readZipEntries(zipStored);
  if (Object.keys(entries1).length !== 1 || !entries1["test.xml"].equals(original)) {
    throw new Error("selfTest 실패: store 방식 왕복 불일치");
  }

  const deflated = zlib.deflateRawSync(original);
  const zipDeflate = buildZip("test2.xml", original, deflated, 8);
  const entries2 = readZipEntries(zipDeflate);
  if (!entries2["test2.xml"].equals(original)) {
    throw new Error("selfTest 실패: deflate 방식 왕복 불일치");
  }

  return true;
}
