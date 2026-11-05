import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";

// Node's CLI glob support varies by version; enumerate every nested suite.
const files = readdirSync("src", { recursive: true })
  .filter((file) => file.endsWith(".test.ts"))
  .map((file) => `src/${file}`)
  .sort();
if (!files.length) throw new Error("No viewer unit tests found");
const result = spawnSync(process.execPath, ["--import", "tsx", "--test", ...files], {
  stdio: "inherit",
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
