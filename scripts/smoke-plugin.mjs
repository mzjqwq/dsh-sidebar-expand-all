#!/usr/bin/env node
/**
 * Offline smoke test for the plugin halves.
 *
 * `lib/index.js` is a host plugin (importable in plain Node); `lib/client.js`
 * is a browser bundle wrapped in `window.__ModuleLoader__.load({...})`, so it
 * needs a minimal DOM stub before it can even be evaluated. This script loads
 * both halves, checks the exported contract, and runs the browser half's
 * `apply()` against a stub cordis context — catching syntax errors, renamed
 * exports and crashes at mount time without starting a DSH instance.
 *
 *   node scripts/smoke-plugin.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const failures = [];
const pass = (label, value) => console.log(`  ok   ${label}${value === undefined ? "" : ` = ${value}`}`);

// ---------------------------------------------------------------- host half
console.log("host: lib/index.js");
const host = await import(pathToFileURL(path.join(root, "lib", "index.js")).href);
if (host.name !== "dsh-sidebar-expand-all") failures.push(`unexpected plugin name: ${host.name}`);
else pass("name", host.name);
if (typeof host.apply !== "function") failures.push("apply is not a function");
else pass("apply", "function");
const asarPatch = await import(pathToFileURL(path.join(root, "lib", "asar-patch.js")).href);
for (const key of ["ENTRY", "PATCHES", "inspect", "apply", "restore"]) {
  if (asarPatch[key] === undefined) failures.push(`lib/asar-patch.js is missing ${key}`);
}
if (!failures.length) pass("asar-patch exports", "ENTRY, PATCHES, inspect, apply, restore");
pass("patch count", asarPatch.PATCHES.length);
for (const patch of asarPatch.PATCHES) {
  if (patch.newText.length > patch.old.length) failures.push(`${patch.id}: replacement is longer than the original (${patch.newText.length} > ${patch.old.length})`);
  else pass(`${patch.id} fits`, `${patch.newText.length}/${patch.old.length} bytes`);
}

// -------------------------------------------------------------- browser half
// This package patches the DSH bundle inside app.asar and ships no browser
// bundle of its own, so the client half is optional: run it when a
// `lib/client.js` exists (e.g. after adding a control-page UI), skip otherwise.
const clientFile = path.join(root, "lib", "client.js");
if (!fs.existsSync(clientFile)) {
  console.log("client: lib/client.js — skipped (this package has no browser bundle)");
} else {
console.log("client: lib/client.js");
const code = fs.readFileSync(clientFile, "utf8");
const makeEl = () => ({
  style: {}, className: "", textContent: "", attributes: {}, children: [],
  setAttribute(k, v) { this.attributes[k] = v; },
  getAttribute(k) { return this.attributes[k] ?? null; },
  hasAttribute(k) { return k in this.attributes; },
  removeAttribute(k) { delete this.attributes[k]; },
  appendChild(child) { this.children.push(child); return child; },
  addEventListener() {}, removeEventListener() {},
  querySelectorAll() { return []; }, querySelector() { return null; },
});
globalThis.window = {
  addEventListener() {}, removeEventListener() {},
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  getComputedStyle: () => ({ getPropertyValue: () => "", display: "block", visibility: "visible" }),
  localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
};
globalThis.document = {
  addEventListener() {}, removeEventListener() {},
  body: makeEl(), head: makeEl(), documentElement: makeEl(),
  querySelectorAll: () => [], querySelector: () => null, getElementById: () => null,
  createElement: makeEl,
};
globalThis.localStorage = globalThis.window.localStorage;
globalThis.MutationObserver = class { observe() {} disconnect() {} };
globalThis.requestAnimationFrame = () => 0;
globalThis.cancelAnimationFrame = () => {};
let registered = null;
globalThis.window.__ModuleLoader__ = { load(entry) { registered = entry; } };

new Function(
  "window", "document", "localStorage", "MutationObserver", "requestAnimationFrame", "cancelAnimationFrame",
  code,
)(globalThis.window, globalThis.document, globalThis.localStorage, globalThis.MutationObserver,
  globalThis.requestAnimationFrame, globalThis.cancelAnimationFrame);

if (!registered) failures.push("client bundle did not call window.__ModuleLoader__.load()");
else {
  pass("module id", registered.id);
  const reactStub = () => ({
    createElement: () => null,
    useEffect() {}, useState: (v) => [v, () => {}], useRef: (v) => ({ current: v }),
  });
  const client = registered.factory((name) => {
    if (name === "react") return reactStub();
    if (name === "react-dom/client") return { createRoot: () => ({ render() {}, unmount() {} }) };
    return {};
  });
  pass("exports", Object.keys(client).join(", "));
  const ctx = {
    slots: {
      entries: (slot) => (slot === "settings.section" ? [{ id: "general", order: 10 }, { id: "cost-meter", order: 30 }] : []),
      subscribe: () => () => {},
    },
    locale: { subscribe: () => () => {} },
    effect: (fn) => { fn(); },
    on() {},
  };
  if (typeof client.apply !== "function") failures.push("client apply is not a function");
  else {
    const dispose = client.apply(ctx);
    pass("apply()", typeof dispose === "function" ? "returns dispose" : "mounted");
    if (typeof dispose === "function") { dispose(); pass("dispose()", "ok"); }
  }
}
}

// -------------------------------------------------------------------- result
if (failures.length) {
  console.error("\nSMOKE FAILED");
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log("\nSMOKE OK");
