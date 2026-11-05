import Hls from "hls.js";
import { RadioHlsLoader } from "./hls-loader";

export function attachHls(audio: HTMLAudioElement, url: string, failed: (reason: string) => void) {
  if (!Hls.isSupported()) throw new Error("radio:errorHlsUnsupported");
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
    failed(data.type === Hls.ErrorTypes.NETWORK_ERROR ? "radio:errorNetwork"
      : data.type === Hls.ErrorTypes.MEDIA_ERROR ? "radio:errorHlsDecode"
      : "radio:errorHls");
  });
  hls.loadSource(url);
  hls.attachMedia(audio);
  return hls;
}
