import { create } from "zustand";
import { Service, events, type Settings, type SettingsPatch } from "./mygo";

export const defaultSettings: Settings = {
  language: "system", appearance: "system", resume: "selection", autoSyncDays: 7, closeBehavior: "hide",
  playbackAnimations: true,
  proxyMode: "auto", proxyURL: "",
};

interface SettingsState {
  value: Settings;
  ready: boolean;
  saving: boolean;
  error: string;
  load: () => Promise<void>;
  update: (patch: SettingsPatch) => Promise<void>;
}

let initialized = false;
let revision = 0;
let pending = 0;
let queue = Promise.resolve();
export const useSettings = create<SettingsState>((set) => ({
  value: defaultSettings, ready: false, saving: false, error: "",
  load: async () => {
    if (!initialized) {
      initialized = true;
      events.settingsChanged.on((value) => { revision++; set({ value, ready: true }); });
    }
    const seq = revision;
    try {
      const value = await Service.getSettings();
      if (revision === seq) set({ value, ready: true, error: "" });
    } catch (e) {
      set({ error: String(e) });
    }
  },
  update: (patch) => {
    pending++;
    set({ saving: true, error: "" });
    const task = queue.then(async () => {
      try {
        const value = await Service.updateSettings(patch);
        revision++;
        set({ value, error: "" });
      } catch (e) {
        set({ error: String(e) });
      } finally {
        pending--;
        set({ saving: pending > 0 });
      }
    });
    queue = task;
    return task;
  },
}));
