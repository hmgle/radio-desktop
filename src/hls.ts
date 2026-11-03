import Hls from "hls.js";
import { RadioHlsLoader } from "./hls-loader";

export function attachHls(audio: HTMLAudioElement, url: string, failed: (reason: string) => void) {
  if (!Hls.isSupported()) throw new Error("当前系统不支持此 HLS 音频格式");
  const hls = new Hls({
    loader: RadioHlsLoader,
    // The ESM build runs transmuxing locally. No CDN or external worker
    // is needed in either development or packaged custom-scheme pages.
    enableWorker: false,
    maxBufferLength: 15,
    backBufferLength: 0,
  });
  hls.on(Hls.Events.ERROR, (_event, data) => {
    if (!data.fatal) return;
    console.warn("HLS playback failed", data.details, data.error);
    failed(data.type === Hls.ErrorTypes.NETWORK_ERROR ? "电台连接失败，请重试或切换电台"
      : data.type === Hls.ErrorTypes.MEDIA_ERROR ? "当前系统无法解码此电台音频"
      : "HLS 播放失败，请重试或切换电台");
  });
  hls.loadSource(url);
  hls.attachMedia(audio);
  return hls;
}
