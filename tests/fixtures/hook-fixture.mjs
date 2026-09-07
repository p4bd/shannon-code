import { execSync } from "node:child_process";

let raw = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) {
  raw += chunk;
}

const payload = JSON.parse(raw || "{}");
const mode = process.argv[2] ?? "allow";

switch (mode) {
  case "allow":
    write({ action: "allow" });
    break;
  case "deny-run-shell":
    write(
      payload.toolName === "run_shell"
        ? { action: "deny", reason: "run_shell is blocked by hook" }
        : { action: "allow" },
    );
    break;
  case "modify-read-target":
    write({ action: "modify", toolInput: { path: "modified.txt" } });
    break;
  case "append":
    write({ action: "append", message: `hook appended for ${payload.event}` });
    break;
  case "append-tool":
    write({ action: "append", message: `post hook saw ${payload.toolName}` });
    break;
  case "post-npm-test": {
    try {
      const output = execSync("npm test", {
        cwd: payload.cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
      write({
        action: "append",
        message: `npm test passed\n${output.trimEnd()}`,
      });
    } catch (error) {
      write({
        action: "append",
        message: `npm test failed\n${String(error)}`,
      });
    }
    break;
  }
  case "crash":
    process.exit(2);
    break;
  case "invalid":
    process.stdout.write("not json");
    break;
  default:
    write({ action: "allow" });
}

function write(value) {
  process.stdout.write(JSON.stringify(value));
}
