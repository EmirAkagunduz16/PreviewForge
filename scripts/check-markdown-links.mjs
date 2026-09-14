import { access, readdir, readFile } from "node:fs/promises";
import { dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ignoredDirectories = new Set([".git", ".next", ".turbo", "dist", "node_modules"]);
const markdownFiles = await collectMarkdownFiles(repositoryRoot);
const failures = [];
let checkedLinks = 0;
let skippedExternalLinks = 0;

for (const sourcePath of markdownFiles) {
  const content = await readFile(sourcePath, "utf8");
  const links = content.matchAll(/!?\[[^\]]*\]\(([^)]+)\)/g);

  for (const match of links) {
    const rawTarget = match[1]?.trim();
    if (!rawTarget || isExternalOrAnchor(rawTarget)) {
      continue;
    }

    const withoutTitle = rawTarget.startsWith("<")
      ? rawTarget.slice(1, rawTarget.indexOf(">"))
      : rawTarget.split(/\s+["']/u, 1)[0];
    const decodedTarget = decodeURIComponent(withoutTitle.split("#", 1)[0]);
    const targetPath = resolve(dirname(sourcePath), decodedTarget);

    const relativeTarget = relative(repositoryRoot, targetPath);
    if (relativeTarget.startsWith("..") || isAbsolute(relativeTarget)) {
      skippedExternalLinks += 1;
      continue;
    }

    checkedLinks += 1;

    try {
      await access(targetPath);
    } catch {
      failures.push(
        `${sourcePath.slice(repositoryRoot.length + 1)} -> ${rawTarget} (resolved to ${targetPath})`,
      );
    }
  }
}

if (failures.length > 0) {
  process.stderr.write(
    `Broken local Markdown links:\n${failures.map((item) => `- ${item}`).join("\n")}\n`,
  );
  process.exitCode = 1;
} else {
  process.stdout.write(
    `Verified ${checkedLinks} local Markdown links across ${markdownFiles.length} files; skipped ${skippedExternalLinks} repository-external links.\n`,
  );
}

async function collectMarkdownFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) {
      continue;
    }

    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectMarkdownFiles(path)));
    } else if (entry.isFile() && extname(entry.name) === ".md") {
      files.push(path);
    }
  }

  return files;
}

function isExternalOrAnchor(target) {
  return (
    target.startsWith("#") ||
    target.startsWith("http://") ||
    target.startsWith("https://") ||
    target.startsWith("mailto:")
  );
}
