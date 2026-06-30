export const sandboxToolRunnerSource = String.raw`
const fs = require("node:fs");
const path = require("node:path");
const childProcess = require("node:child_process");

const workspace = "/workspace";
const payload = JSON.parse(Buffer.from(process.argv[2], "base64url").toString("utf8"));
const ignored = new Set([".git", ".igzpatch-runtime", ".next", "coverage", "dist", "node_modules"]);
const sensitive = new Set([".netrc", ".npmrc", ".pypirc"]);

function normalizePath(value) {
  if (typeof value !== "string" || path.isAbsolute(value)) throw new Error("Path must be relative");
  const normalized = path.normalize(value).split(path.sep).join("/").replace(/^\.\//, "") || ".";
  if (normalized === ".." || normalized.startsWith("../")) throw new Error("Path escapes workspace");
  return normalized;
}

function absolute(value) {
  const normalized = normalizePath(value);
  const result = path.resolve(workspace, normalized);
  if (result !== workspace && !result.startsWith(workspace + path.sep)) throw new Error("Path escapes workspace");
  return { normalized, result };
}

function readable(value) {
  const resolved = absolute(value);
  const realWorkspace = fs.realpathSync(workspace);
  const realResult = fs.realpathSync(resolved.result);
  if (realResult !== realWorkspace && !realResult.startsWith(realWorkspace + path.sep)) throw new Error("Path escapes through symlink");
  return { normalized: resolved.normalized, result: realResult };
}

function isSensitive(value) {
  const normalized = normalizePath(value);
  const parts = normalized.split("/");
  const name = parts.at(-1) || "";
  return parts.includes(".git") || name === ".env" || name.startsWith(".env.") || sensitive.has(name);
}

function matchesGlob(value, glob) {
  let pattern = "^";
  for (let index = 0; index < glob.length; index += 1) {
    const character = glob[index];
    if (character === "*" && glob[index + 1] === "*") { pattern += ".*"; index += 1; }
    else if (character === "*") pattern += "[^/]*";
    else if (character === "?") pattern += "[^/]";
    else pattern += character.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
  }
  return new RegExp(pattern + "$").test(value);
}

function writable(value) {
  const resolved = absolute(value);
  if (!payload.allowed.some((glob) => matchesGlob(resolved.normalized, glob))) throw new Error("Path is outside paths.allowed");
  if (payload.blocked.some((glob) => matchesGlob(resolved.normalized, glob))) throw new Error("Path matches paths.blocked");
  let ancestor = resolved.result;
  while (!fs.existsSync(ancestor)) ancestor = path.dirname(ancestor);
  const realWorkspace = fs.realpathSync(workspace);
  const realAncestor = fs.realpathSync(ancestor);
  if (realAncestor !== realWorkspace && !realAncestor.startsWith(realWorkspace + path.sep)) throw new Error("Path escapes through symlink");
  if (fs.existsSync(resolved.result) && fs.lstatSync(resolved.result).isSymbolicLink()) throw new Error("Refusing to write symlink");
  return resolved;
}

function collect(start) {
  const files = [];
  const pending = [start];
  while (pending.length && files.length < 500) {
    const current = pending.pop();
    const stat = fs.statSync(current);
    if (stat.isFile()) { files.push(current); continue; }
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (ignored.has(entry.name) || entry.isSymbolicLink()) continue;
      const candidate = path.resolve(current, entry.name);
      if (entry.isDirectory()) pending.push(candidate);
      else if (entry.isFile()) files.push(candidate);
      if (files.length >= 500) break;
    }
  }
  return files.sort();
}

const args = payload.arguments || {};
let output;
switch (payload.name) {
  case "list_files": {
    const start = readable(args.path || ".").result;
    const files = collect(start).map((file) => path.relative(workspace, file).split(path.sep).join("/")).filter((file) => !isSensitive(file));
    output = JSON.stringify({ ok: true, files, truncated: files.length === 500 });
    break;
  }
  case "read_file": {
    if (isSensitive(args.path)) throw new Error("Refusing to read sensitive path");
    const file = readable(args.path).result;
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > 1000000) throw new Error("File is unavailable or too large");
    const start = Number.isInteger(args.start_line) && args.start_line > 0 ? args.start_line : 1;
    const end = Number.isInteger(args.end_line) && args.end_line > 0 ? args.end_line : start + 399;
    output = fs.readFileSync(file, "utf8").split("\n").slice(start - 1, end).map((line, index) => String(start + index) + ": " + line).join("\n");
    break;
  }
  case "search_files": {
    const query = String(args.query || "").toLocaleLowerCase();
    if (!query) throw new Error("query must be non-empty");
    const matches = [];
    for (const file of collect(readable(args.path || ".").result)) {
      const relative = path.relative(workspace, file).split(path.sep).join("/");
      if (isSensitive(relative) || fs.statSync(file).size > 1000000) continue;
      const content = fs.readFileSync(file, "utf8");
      if (content.includes("\0")) continue;
      content.split("\n").forEach((line, index) => {
        if (matches.length < 100 && line.toLocaleLowerCase().includes(query)) matches.push(relative + ":" + String(index + 1) + ":" + line);
      });
      if (matches.length >= 100) break;
    }
    output = JSON.stringify({ ok: true, matches, truncated: matches.length === 100 });
    break;
  }
  case "get_diff": {
    output = childProcess.execFileSync("git", ["-c", "core.hooksPath=/dev/null", "diff", "--no-ext-diff", "--unified=3", "--"], {
      cwd: workspace,
      encoding: "utf8",
      env: { PATH: process.env.PATH, HOME: "/tmp", GIT_CONFIG_NOSYSTEM: "1" },
      maxBuffer: 1000000,
    }) || "No diff yet.";
    break;
  }
  case "write_file": {
    if (typeof args.content !== "string") throw new Error("content must be a string");
    const file = writable(args.path);
    fs.mkdirSync(path.dirname(file.result), { recursive: true });
    fs.writeFileSync(file.result, args.content, "utf8");
    output = JSON.stringify({ ok: true, path: file.normalized, bytes: Buffer.byteLength(args.content) });
    break;
  }
  case "replace_in_file": {
    if (typeof args.old_text !== "string" || !args.old_text || typeof args.new_text !== "string") throw new Error("replacement text is invalid");
    const file = writable(args.path);
    const content = fs.readFileSync(file.result, "utf8");
    const first = content.indexOf(args.old_text);
    if (first === -1 || content.indexOf(args.old_text, first + args.old_text.length) !== -1) throw new Error("old_text must occur exactly once");
    fs.writeFileSync(file.result, content.slice(0, first) + args.new_text + content.slice(first + args.old_text.length), "utf8");
    output = JSON.stringify({ ok: true, path: file.normalized });
    break;
  }
  default: throw new Error("Unknown sandbox tool");
}
process.stdout.write(String(output).slice(0, 30000));
`;
