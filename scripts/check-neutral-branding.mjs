import { spawnSync } from "node:child_process";

const forbiddenNames = [
  "蓝" + "卓",
  "中" + "控",
  "blue" + "tron",
  "sup" + "con",
];

const result = spawnSync("git", [
  "grep",
  "-n",
  "-I",
  "-i",
  "-E",
  forbiddenNames.join("|"),
  "--",
  ".",
  ":(exclude)vendor/**",
  ":(exclude).omx/**",
], {
  cwd: new URL("..", import.meta.url),
  encoding: "utf8",
});

if (result.status === 1) {
  console.log("Branding check passed: no restricted organization names found.");
  process.exit(0);
}

if (result.status !== 0) {
  process.stderr.write(result.stderr || "Branding check failed to scan the repository.\n");
  process.exit(result.status ?? 1);
}

process.stderr.write("Restricted organization names found:\n");
process.stderr.write(result.stdout);
process.exit(1);
