/**
 * Browser stand-in for Node's "module" builtin. harfbuzzjs's Emscripten
 * loader does `await import("module")` only when it runs in Node, but the
 * bundler still has to resolve it (next.config.ts turbopack.resolveAlias).
 */
export function createRequire(): never {
  throw new Error('"module" is not available in the browser');
}
