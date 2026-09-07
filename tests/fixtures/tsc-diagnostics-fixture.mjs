import { readFileSync } from "node:fs";
import { join } from "node:path";

const targetPath = process.argv[2] ?? "src/index.ts";
let content = "";
try {
  content = readFileSync(join(process.cwd(), targetPath), "utf8");
} catch (error) {
  process.stderr.write(String(error));
  process.exit(2);
}

if (content.includes('"bad"') || content.includes("'bad'")) {
  process.stdout.write(
    `${targetPath}(1,14): error TS2322: Type 'string' is not assignable to type 'number'.\n`,
  );
  process.exit(2);
}

process.exit(0);

