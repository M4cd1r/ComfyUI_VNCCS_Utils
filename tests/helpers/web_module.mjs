// Imports a UniCanvas web module the way the browser does: with the entry's ?v= version query.
// Every web module imports its UniCanvas siblings with that query (scripts/bump_unicanvas_version.mjs),
// so a stateful module (the feature toggles) must be imported the same way here, or the test
// would hold a second instance whose state the modules under test never see.
import { readFileSync } from "node:fs";

const entry = readFileSync(new URL("../../web/vnccs_unicanvas.js", import.meta.url), "utf8");
export const UNICANVAS_WEB_VERSION = entry.match(/const VNCCS_UNICANVAS_VERSION = "(\d+)";/)[1];

export function importUniCanvasWebModule(name) {
  return import(new URL(`../../web/${name}?v=${UNICANVAS_WEB_VERSION}`, import.meta.url).href);
}
