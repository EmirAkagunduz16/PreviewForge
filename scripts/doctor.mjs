import { execFileSync } from "node:child_process";

const requirements = [
  { command: "node", args: ["--version"], required: true },
  { command: "pnpm", args: ["--version"], required: true },
  { command: "docker", args: ["--version"], required: true },
  { command: "kubectl", args: ["version", "--client"], required: true },
  { command: "kind", args: ["version"], required: false },
];

let failed = false;

for (const requirement of requirements) {
  try {
    const version =
      execFileSync(requirement.command, requirement.args, {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      })
        .trim()
        .split("\n")[0] || "available";
    console.log(`ok       ${requirement.command.padEnd(10)} ${version}`);
  } catch {
    const status = requirement.required ? "missing" : "optional";
    console.log(`${status.padEnd(8)} ${requirement.command}`);
    failed ||= requirement.required;
  }
}

const dockerContext =
  process.env.PREVIEWFORGE_DOCKER_CONTEXT ?? process.env.DOCKER_CONTEXT ?? "default";

try {
  const serverVersion = execFileSync(
    "docker",
    ["--context", dockerContext, "info", "--format", "{{.ServerVersion}}"],
    {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  ).trim();
  execFileSync("docker", ["--context", dockerContext, "compose", "version"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  console.log(
    `ok       ${"docker-daemon".padEnd(14)} context=${dockerContext} server=${serverVersion}`,
  );
} catch {
  console.log(`missing  ${"docker-daemon".padEnd(14)} context=${dockerContext}`);
  failed = true;
}

if (failed) {
  process.exitCode = 1;
}
