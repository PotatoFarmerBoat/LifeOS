// Sentinel: bun <file>.ts explicit invocation — the guaranteed-portable form.
import { appendFileSync } from "node:fs";
appendFileSync("C:/Users/zachary.simandl/code/lifeos-sandbox/hooklog.txt", `S3-ts-explicit ran, platform=${process.platform}\n`);
