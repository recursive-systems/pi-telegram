// No installs or host SDK imports. Resolve Pi's public parser from the explicit
// installed package while retaining this worktree's read-only legacy peers.
import { registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import assert from 'node:assert/strict';
assert.ok(process.env.PI_PACKAGE_DIR, 'set PI_PACKAGE_DIR explicitly');
registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier === '@earendil-works/pi-tui') return nextResolve(pathToFileURL(join(process.env.PI_PACKAGE_DIR, 'node_modules/@earendil-works/pi-tui/dist/index.js')).href, context);
  return nextResolve(specifier, context);
} });
