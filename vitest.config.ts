import { defineConfig } from 'vitest/config';

// Many tests compile and solve whole models (the frog alone takes a few seconds on a slow
// machine), so the default 5 s per test is too tight for CI. Tests that need longer say so.
export default defineConfig({
  test: { testTimeout: 60_000 },
});
