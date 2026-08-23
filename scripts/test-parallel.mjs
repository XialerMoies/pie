import process from "node:process";
import { runGates } from "./test-gates.mjs";

const results = await runGates({ selected: ["unit", "routes", "frontend", "css-vars"] });
if (results.some((result) => result.code !== 0 || result.signal || result.exceeded)) process.exitCode = 1;
