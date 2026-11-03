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
  const init = useRadio((s) => s.init);
  const dialog = useRadio((s) => s.dialog);
  const openDialog = useRadio((s) => s.openDialog);

  useEffect(() => {
    void init();
  }, [init]);

  // Space toggles play/pause and Cmd/Ctrl+F focuses the search box,
  // unless typing in an input.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      const typing =
        el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" ||
        el.tagName === "BUTTON" || el.isContentEditable;
      if (e.code === "Space" && !typing) {
        e.preventDefault();
        useRadio.getState().togglePlay();
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "f") {
        e.preventDefault();
        const input = document.getElementById("search-input") as HTMLInputElement | null;
        input?.focus();
        input?.select();
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
    const onBeforeUnload = () => player.stop();
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, []);

  return (
    <div className="flex h-full flex-col">
      <div className="flex min-h-0 flex-1">
        <Sidebar onAddStation={() => openDialog("add")} onPlayURL={() => openDialog("url")} />
        <main className="flex min-w-0 flex-1 flex-col">
          <FilterBar />
          <StationList />
        </main>
      </div>
      <PlayerBar />
      <NowPlayingLayer />
      {dialog === "add" && <AddStationDialog onClose={() => openDialog(null)} />}
      {dialog === "url" && <PlayURLDialog onClose={() => openDialog(null)} />}
    </div>
  );
}
