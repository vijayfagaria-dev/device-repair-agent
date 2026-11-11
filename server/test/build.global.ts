// Builds every workspace once before the tests, so boot tests run the current compiled server and real web build.
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export default function setup(): void {
  const root = fileURLToPath(new URL("../..", import.meta.url));
  execFileSync("npm", ["run", "build", "--silent"], { cwd: root, stdio: ["ignore", "ignore", "inherit"] });
}
