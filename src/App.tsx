import { SettingsPage } from "./components/SettingsPage";
import { useLocale } from "./i18n";
import { useEffect } from "react";
import { currentWindow } from "mygo-runtime";
import { useRadio } from "./store";
import { player } from "./player";
import { Sidebar } from "./components/Sidebar";
import { FilterBar } from "./components/FilterBar";
import { StationList } from "./components/StationList";
import { PlayerBar } from "./components/PlayerBar";
import { AddStationDialog, PlayURLDialog } from "./components/Dialogs";
import { NowPlayingLayer } from "./components/NowPlayingLayer";

export default function App() {
  useLocale();
  const settingsOpen = useRadio((s) => s.settingsOpen);
  const init = useRadio((s) => s.init);
  const dialog = useRadio((s) => s.dialog);
  const openDialog = useRadio((s) => s.openDialog);

  useEffect(() => {
    void init();
  }, [init]);

  // Space toggles play/pause outside interactive controls; Cmd/Ctrl+F
  // returns to the station view and focuses search.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      const interactive =
        el.closest?.('input, textarea, select, button, summary, [role="button"]') || el.isContentEditable;
      const state = useRadio.getState();
      const key = e.key.toLowerCase();
      const command = (e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey;
      const navigation = command && [",", "n", "l", "f"].includes(key);
      const closeSettings = e.key === "Escape" && state.settingsOpen;
      const togglePlayback = e.code === "Space" && !interactive && !state.settingsOpen;
      if (!navigation && !closeSettings && !togglePlayback) return;
      if (state.dialog || document.querySelector('[role="dialog"][aria-modal="true"]')) return;
      if (command && key === ",") {
        e.preventDefault();
        state.openSettings(true);
        return;
      }
      if (command && (key === "n" || key === "l")) {
        e.preventDefault();
        state.openDialog(key === "n" ? "add" : "url");
        return;
      }
      if (closeSettings) {
        state.openSettings(false);
        return;
      }
      if (togglePlayback) {
        e.preventDefault();
        useRadio.getState().togglePlay();
      }
      if (command && key === "f") {
        e.preventDefault();
        // Returning to the station view also dismisses Now Playing.
        state.openSettings(false);
        requestAnimationFrame(() => {
          const current = useRadio.getState();
          if (current.settingsOpen || current.nowPlayingOpen || current.dialog || document.querySelector('[role="dialog"][aria-modal="true"]')) return;
          const input = document.getElementById("search-input") as HTMLInputElement | null;
          input?.focus();
          input?.select();
        });
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  // The window says what plays: "ICY 曲名 - 电台名 — Radio Desktop".
  const titleStation = useRadio((s) => s.station?.name);
  const titleTrack = useRadio((s) => s.title);
  const titlePlaying = useRadio((s) => s.playState === "playing");
  useEffect(() => {
    let title = "Radio Desktop";
    if (titleStation) {
      title = titlePlaying && titleTrack ? `${titleTrack} - ${titleStation}` : titleStation;
      title += " — Radio Desktop";
    }
    currentWindow.setTitle(title).catch(() => {});
  }, [titleStation, titleTrack, titlePlaying]);

  // Stop the ICY sidecar when the page unloads.
  useEffect(() => {
    const onBeforeUnload = () => {
      void useRadio.getState().flushVolume();
      player.stop();
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, []);

  return (
    <div className="flex h-full flex-col">
      <div className="flex min-h-0 flex-1">
        <Sidebar onAddStation={() => openDialog("add")} onPlayURL={() => openDialog("url")} />
        <main className="flex min-w-0 flex-1 flex-col">
          <div className="flex min-h-0 flex-1 flex-col" hidden={settingsOpen}>
            <FilterBar />
            <StationList />
          </div>
          {settingsOpen && <SettingsPage />}
        </main>
      </div>
      <PlayerBar />
      <NowPlayingLayer />
      {dialog === "add" && <AddStationDialog onClose={() => openDialog(null)} />}
      {dialog === "url" && <PlayURLDialog onClose={() => openDialog(null)} />}
    </div>
  );
}
