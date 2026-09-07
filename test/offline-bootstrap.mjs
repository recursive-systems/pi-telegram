// No installs, scanning other checkouts, or host SDK imports. Normal project
// resolution by default; explicit installed-package overrides for bare worktrees.
import { registerHooks } from 'node:module';
import { resolveDependency } from './offline-dependencies.mjs';
registerHooks({ resolve: resolveDependency });
