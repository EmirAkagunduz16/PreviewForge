import { spawnSync } from "node:child_process";

const context = process.env.PREVIEWFORGE_DOCKER_CONTEXT ?? process.env.DOCKER_CONTEXT ?? "default";
const command = process.argv.slice(2);

if (command.length === 0) {
  console.error("Usage: node scripts/local-infra.mjs <compose command...>");
  process.exit(1);
}

const result = spawnSync(
  "docker",
  ["--context", context, "compose", "-f", "infrastructure/local/compose.yaml", ...command],
  { stdio: "inherit" },
);

if (result.error) {
  console.error(`Unable to run Docker Compose with context ${context}: ${result.error.message}`);
  process.exit(1);
}

process.exitCode = result.status ?? 1;
