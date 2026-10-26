import { defineConfig } from "mygo-cli";

export default defineConfig({
  name: "radio-desktop",
  identifier: "com.hmgle.radio-desktop",
  version: "0.1.0",
  // `mygo dev` runs devCommand and loads devUrl; `mygo build` runs
  // buildCommand and embeds frontendDist into the app.
  devUrl: "http://localhost:5173",
  devCommand: "bun run dev:web",
  buildCommand: "bun run build:web",
  frontendDist: "dist",
  bindings: "src/mygo.ts",
  out: "build",
  macOS: {
    // Radio streams are plain HTTP all over the directory; without this
    // exception macOS App Transport Security blocks every http://
    // <audio> load with MEDIA_ERR_SRC_NOT_SUPPORTED.
    infoPlist: {
      NSAppTransportSecurity: {
        NSAllowsArbitraryLoads: true,
      },
    },
  },
});
