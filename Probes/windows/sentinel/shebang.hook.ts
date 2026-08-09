#!/usr/bin/env bun
// Sentinel: does a bare .ts hook invoked by path execute via shebang on Windows (Git Bash)?
import { appendFileSync } from "node:fs";
appendFileSync("C:/Users/zachary.simandl/code/lifeos-sandbox/hooklog.txt", `S2-ts-shebang ran, HOME=${process.env.HOME ?? "unset"}\n`);
