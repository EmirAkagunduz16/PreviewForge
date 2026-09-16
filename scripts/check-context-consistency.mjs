import { execFileSync } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const errors = [];

const read = (path) => readFile(join(repositoryRoot, path), "utf8");
const [readme, roadmap, activeBacklog, archiveBacklog] = await Promise.all([
  read("README.md"),
  read("docs/delivery/roadmap.md"),
  read("docs/backlog/active.md"),
  read("docs/backlog/archive.md"),
]);

const roadmapMilestones = new Map();
for (const match of roadmap.matchAll(/^##\s+M(\d+)\s+[^\n]*\((complete|active)\)/gmu)) {
  roadmapMilestones.set(`M${match[1]}`, match[2]);
}

const currentMilestone = readme.match(/repository is in M(\d+)/u)?.[1];
const activeRoadmapMilestones = [...roadmapMilestones.entries()].filter(
  ([, status]) => status === "active",
);
if (activeRoadmapMilestones.length !== 1) {
  errors.push(
    `roadmap must contain exactly one active milestone; found ${activeRoadmapMilestones.length}`,
  );
} else if (currentMilestone !== activeRoadmapMilestones[0][0].slice(1)) {
  errors.push(
    `README current milestone M${currentMilestone ?? "?"} does not match roadmap ${activeRoadmapMilestones[0][0]}`,
  );
}

const planFiles = (await readdir(join(repositoryRoot, "docs/plans"))).filter((name) =>
  name.endsWith(".md"),
);
for (const planFile of planFiles) {
  const content = await read(`docs/plans/${planFile}`);
  const milestone = content.match(/^#\s+(M\d+)\b/mu)?.[1];
  const status = content.match(/^Status:\s+(\w+)/mu)?.[1];
  if (!milestone || !status || !roadmapMilestones.has(milestone)) continue;
  if (roadmapMilestones.get(milestone) !== status) {
    errors.push(
      `${planFile} status ${status} does not match roadmap ${milestone} status ${roadmapMilestones.get(milestone)}`,
    );
  }
  if (status === "complete" && !/^Completion evidence:/mu.test(content)) {
    errors.push(`${planFile} is complete but has no Completion evidence link`);
  }
}

const activeEntries = [
  ...activeBacklog.matchAll(/^- id:\s+([^\n]+)([\s\S]*?)(?=\n- id:|\n```|(?![\s\S]))/gmu),
].map(([, id, body]) => ({
  id: id.trim(),
  body,
}));
const activeIds = new Set();
for (const { id, body } of activeEntries) {
  if (activeIds.has(id)) errors.push(`active backlog duplicates ${id}`);
  activeIds.add(id);
  const status = body.match(/^\s+status:\s+(\S+)/mu)?.[1];
  const nextAction = body.match(/^\s+next_action:\s*(.*)$/mu)?.[1]?.trim();
  const acceptance = body.match(/^\s+acceptance:\s*(.*)$/mu)?.[1]?.trim();
  const evidence = body.match(/^\s+evidence:\s*(.*)$/mu)?.[1]?.trim();
  const acceptanceRef = body.match(/^\s+acceptance_ref:\s*(.*)$/mu)?.[1]?.trim();
  const ownedPaths = body
    .match(/^\s+owned_paths:\s*\[([^\]]*)\]/mu)?.[1]
    ?.split(",")
    .map((path) => path.trim())
    .filter(Boolean);
  const verificationCommand = body.match(/^\s+verification_command:\s*(.*)$/mu)?.[1]?.trim();
  const evidenceCommit = body.match(/^\s+evidence_commit:\s*(.*)$/mu)?.[1]?.trim();
  if (!status || !["queued", "in-progress", "blocked", "needs-review"].includes(status))
    errors.push(`${id} has invalid or missing status`);
  if (!nextAction) errors.push(`${id} has no next_action`);
  if (!acceptance) errors.push(`${id} has no acceptance criterion`);
  if (!evidence) errors.push(`${id} has no evidence field`);
  if (!acceptanceRef?.includes("#")) errors.push(`${id} has no acceptance_ref`);
  if (!ownedPaths?.length) errors.push(`${id} has no owned_paths`);
  if (!verificationCommand) errors.push(`${id} has no verification_command`);
  if (!evidenceCommit) errors.push(`${id} has no evidence_commit`);
  if (status === "needs-review" && (!evidence || evidence === "not-run"))
    errors.push(`${id} is needs-review but evidence is not recorded`);

  if (acceptanceRef) {
    const [target, fragment] = acceptanceRef.split("#", 2);
    try {
      const targetContent = await read(target);
      if (fragment && !targetContent.includes(fragment))
        errors.push(`${id} acceptance_ref fragment ${fragment} was not found in ${target}`);
    } catch {
      errors.push(`${id} acceptance_ref target ${target} does not exist`);
    }
  }

  if (evidenceCommit && evidenceCommit !== "not-run") {
    if (!/^[0-9a-f]{7,40}$/u.test(evidenceCommit)) {
      errors.push(`${id} evidence_commit is not a commit hash`);
    } else {
      try {
        const changedFiles = execFileSync(
          "git",
          ["diff-tree", "--no-commit-id", "--name-only", "-r", evidenceCommit],
          { cwd: repositoryRoot, encoding: "utf8" },
        )
          .trim()
          .split("\n")
          .filter(Boolean);
        for (const file of changedFiles) {
          if (
            !ownedPaths?.some(
              (ownedPath) =>
                file === ownedPath ||
                file.startsWith(ownedPath.endsWith("/") ? ownedPath : `${ownedPath}/`),
            )
          ) {
            errors.push(`${id} evidence commit ${evidenceCommit} changed unowned path ${file}`);
          }
        }
      } catch {
        errors.push(`${id} evidence_commit ${evidenceCommit} is not present in git history`);
      }
    }
  }
}

const archiveIds = [...archiveBacklog.matchAll(/^\|\s*([^|]+?)\s*\|/gmu)].map(([, id]) =>
  id.trim(),
);
for (const id of activeIds) {
  if (archiveIds.includes(id)) errors.push(`${id} appears in both active.md and archive.md`);
}

if (errors.length > 0) {
  process.stderr.write(
    `Context consistency failures:\n${errors.map((error) => `- ${error}`).join("\n")}\n`,
  );
  process.exitCode = 1;
} else {
  process.stdout.write(
    `Context consistency passed: ${roadmapMilestones.size} roadmap milestones, ${planFiles.length} plans, ${activeEntries.length} active backlog entries.\n`,
  );
}
