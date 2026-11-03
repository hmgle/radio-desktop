// Local Twemoji assets; regenerate with bun tools/update-flags.ts.
// Keep SVGs separate from JS so repeated flags share one image resource.
const assets = import.meta.glob<string>("./assets/flags/*.svg", {
  eager: true,
  query: "?no-inline",
  import: "default",
});

export function countryFlagUrl(code: string): string | undefined {
  return assets[`./assets/flags/${code}.svg`];
}
