import { spawnSync } from "node:child_process";
import { copyFile, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const source = fileURLToPath(new URL(".", import.meta.url));
const [commit, destinationArg] = process.argv.slice(2);
if (!/^[a-f0-9]{40}$/.test(commit ?? "") || !destinationArg) {
  throw new Error("Usage: node prepare-sites-release.mjs <full GitHub commit SHA> <clean Sites release checkout>");
}
const destination = path.resolve(destinationArg);

function run(command, args, cwd) {
  const child = spawnSync(command, args, { cwd, encoding: "utf8" });
  if (child.error) throw child.error;
  if (child.status !== 0) throw new Error(child.stderr.trim() || command + " failed");
  return child.stdout.trim();
}
const git = (cwd, ...args) => run("git", args, cwd);
const root = cwd => path.resolve(git(cwd, "rev-parse", "--show-toplevel"));
if (root(source) === root(destination) || root(destination) !== destination) {
  throw new Error("Use a separate Sites release checkout.");
}
if (git(destination, "status", "--porcelain")) throw new Error("The Sites release checkout is not clean.");

const reserved = name => name === "dist/client/build-info.json" || name === "dist/client/mapbox-token.js" ||
  name === "dist/client/data/heatwave/stations.json" || name.startsWith("dist/client/data/heatwave/wow/") ||
  name.startsWith(".openai/") || name.startsWith("dist/server/");
const ciOnly = name => name.startsWith(".github/") || name === ".gitattributes" || name === ".gitignore";
const lists = (cwd, ref) => git(cwd, "ls-tree", "-r", "--name-only", ref).split("\n");
const files = lists(source, commit).filter(name => !ciOnly(name));
if (files.some(reserved)) throw new Error("GitHub includes files reserved for Sites.");
if (!files.includes("dist/client/index.html") || !files.includes("worker/index.mjs")) {
  throw new Error("The GitHub commit does not contain the Heatline application.");
}

const marker = "dist/client/build-info.json";
const previous = git(destination, "ls-files", marker) ?
  JSON.parse(git(destination, "show", "HEAD:" + marker)).commit : undefined;
const current = new Set(files);
const removed = previous && /^[a-f0-9]{40}$/.test(previous) ?
  lists(source, previous).filter(name => !ciOnly(name) && !reserved(name) && !current.has(name)) : [];
const within = (base, name) => {
  const target = path.resolve(base, name);
  if (!target.startsWith(base + path.sep)) throw new Error("Invalid repository file path.");
  return target;
};

const temporary = await mkdtemp(path.join(tmpdir(), "heatline-release-"));
try {
  const archive = path.join(temporary, "source.tar");
  const exported = path.join(temporary, "source");
  await mkdir(exported);
  git(source, "archive", "--format=tar", "--output=" + archive, commit);
  run("tar", ["-xf", archive, "-C", exported], source);
  for (const name of files) {
    const target = within(destination, name);
    await mkdir(path.dirname(target), { recursive: true });
    await copyFile(within(exported, name), target);
  }
  for (const name of removed) await rm(within(destination, name), { force: true });
  await writeFile(within(destination, marker), JSON.stringify({
    repository: "Coldzera-010825/Heatline", commit,
  }, null, 2) + "\n");
  console.log("Prepared " + commit + " for the existing Sites project (" + files.length + " files).");
} finally {
  await rm(temporary, { recursive: true, force: true });
}
