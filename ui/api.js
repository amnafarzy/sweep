// The preload bridge (preload.js exposes it as window.sweep). Every view imports
// `api` from here. If the bridge failed to load it is `undefined`, and the
// renderer entry (renderer.js) surfaces a clear message before any view runs.
export const api = window.sweep;
