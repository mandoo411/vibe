/**
 * 정지 이미지(PNG) 1장을 인스타그램 릴스용 무음 mp4로 감싼다.
 * (사용자 요청: "정지 이미지를 릴스로 감싸서 올린다" — 실제 움직이는 모션그래픽이 아니라
 *  릴스 포맷 노출 이점만 취하는 방식. 오디오 트랙 없는 mp4는 일부 플랫폼에서 처리가
 *  불안정하다는 보고가 있어, 무음 오디오 트랙을 넣어 안전하게 만든다.)
 *
 * 요구 스펙(Meta 문서 기준): 9:16, 5~90초, H.264 + AAC, MP4, faststart.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

const DURATION_SEC = 6;

/** pngPath -> mp4Path 변환. 실패 시 예외를 던진다(호출부에서 발행 스킵 처리). */
export async function imageToReelVideo(pngPath, mp4Path) {
  const args = [
    "-y",
    "-loop", "1",
    "-i", pngPath,
    "-f", "lavfi",
    "-i", "anullsrc=channel_layout=stereo:sample_rate=44100",
    "-c:v", "libx264",
    "-t", String(DURATION_SEC),
    "-pix_fmt", "yuv420p",
    "-vf", "scale=1080:1920,format=yuv420p",
    "-c:a", "aac",
    "-b:a", "128k",
    "-shortest",
    "-movflags", "+faststart",
    mp4Path,
  ];
  try {
    await run("ffmpeg", args);
  } catch (err) {
    throw new Error(`ffmpeg 변환 실패: ${err.stderr || err.message}`);
  }
  return mp4Path;
}
