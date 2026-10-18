import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const runner = resolve("node_modules/tsx/dist/cli.mjs");
for (const testFile of ["src/selftest.ts", "src/selftest-policy.ts"]) {
  const result = spawnSync(process.execPath, [runner, testFile], {
    env: { ...process.env, DB_PATH: ":memory:" },
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
