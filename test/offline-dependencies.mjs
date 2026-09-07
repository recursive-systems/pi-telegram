// Delegate discovery to Node without evaluating a Pi SDK/factory entry.
import { isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
export function resolveDependency(specifier, context, nextResolve, env = process.env) {
  const directory = specifier === '@sinclair/typebox' ? env.TYPEBOX_PACKAGE_DIR
    : specifier === '@earendil-works/pi-tui' ? env.PI_PACKAGE_DIR : undefined;
  if (directory === undefined) return nextResolve(specifier, context);
  assert.ok(isAbsolute(directory), 'dependency overrides must be absolute package directories');
  return nextResolve(specifier, { ...context, parentURL: pathToFileURL(join(directory, 'package.json')).href });
}
