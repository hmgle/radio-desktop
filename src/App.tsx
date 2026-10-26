import { useEffect, useState } from "react";
import { useRadio } from "./store";
import { player } from "./player";
import { Sidebar } from "./components/Sidebar";
import { FilterBar } from "./components/FilterBar";
import { StationList } from "./components/StationList";
import { PlayerBar } from "./components/PlayerBar";
import { AddStationDialog, PlayURLDialog } from "./components/Dialogs";

export default function App() {
  const init = useRadio((s) => s.init);
  const [dialog, setDialog] = useState<"add" | "url" | null>(null);

  useEffect(() => {
    void init();
  }, [init]);

  // Space toggles play/pause unless typing in an input.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      const typing =
        el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT";
      if (e.code === "Space" && !typing) {
        e.preventDefault();
        useRadio.getState().togglePlay();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  // Stop the ICY sidecar when the page unloads.
  useEffect(() => {
    const onBeforeUnload = () => player.stop();
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, []);

  return (
    <div className="flex h-full flex-col">
      <div className="flex min-h-0 flex-1">
        <Sidebar
          onAddStation={() => setDialog("add")}
          onPlayURL={() => setDialog("url")}
        />
        <main className="flex min-w-0 flex-1 flex-col">
          <FilterBar />
          <StationList />
        </main>
      </div>
      <PlayerBar />
      {dialog === "add" && <AddStationDialog onClose={() => setDialog(null)} />}
      {dialog === "url" && <PlayURLDialog onClose={() => setDialog(null)} />}
    </div>
  );
}
