import logo from "../../resources/icon.svg";

/** Native controls overlay this strip; MyGo supplies their measured insets. */
export function TitleBar() {
  return (
    <header className="app-titlebar flex shrink-0 select-none items-center gap-2 border-b border-neutral-200 bg-white/70 dark:border-neutral-800 dark:bg-neutral-900/50">
      <img src={logo} alt="" draggable={false} className="h-5 w-5 shrink-0" />
      <span className="truncate text-xs font-semibold">Radio Desktop</span>
    </header>
  );
}
