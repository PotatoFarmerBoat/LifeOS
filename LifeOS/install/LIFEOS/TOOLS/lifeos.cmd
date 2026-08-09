@echo off
rem lifeos launcher shim for Windows (windows-port W9). Same contract as the
rem POSIX alias: run the launcher, which appends LIFEOS_SYSTEM_PROMPT.md to
rem the claude invocation. Requires bun and claude on PATH.
bun "%~dp0lifeos.ts" %*
