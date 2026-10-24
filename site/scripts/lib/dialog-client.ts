// This module is shipped straight to the browser by dialog-server.ts via
// `esbuild.transform()`, which does NOT bundle: it only strips types and
// lowers syntax. Any runtime `import` here would reach the browser as an
// unresolvable bare specifier -- a failure a happy-dom test cannot see,
// which is why tests/shared-purity.test.ts reads this file's source text
// instead of importing it, and why only `import type` is permitted below.

/** What the inline bootstrap script in renderPage() hands to initDialog. */
export interface DialogClientDeps {
  rect: (element: Element) => DOMRect;
  send: (path: string, payload: unknown) => Promise<Response>;
}

// Task 5 implements this: it wires up drawing, the row list, and posting to
// /result and /cancel.
export function initDialog(root: HTMLElement, deps: DialogClientDeps): void {}
