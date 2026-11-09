/* eslint-disable @typescript-eslint/no-require-imports -- the rule also covers require() */
import { exec, execFile, execSync } from "child_process"
import * as cp from "node:child_process"

const proc = require("child_process")

export function backup(dir: string, pattern: RegExp) {
  // ruleid: nerla-exec-template
  exec(`tar -czf backup.tgz ${dir}`)
  // ruleid: nerla-exec-template
  execSync(`du -sh ${dir}`)
  // ruleid: nerla-exec-template
  cp.exec(`ls ${dir}`, () => {})
  // ruleid: nerla-exec-template
  proc.execSync(`rm -rf ${dir}`)
  // ruleid: nerla-exec-template
  require("node:child_process").exec(`cat ${dir}`)
  // ok: nerla-exec-template
  execFile("tar", ["-czf", "backup.tgz", dir])
  // ok: nerla-exec-template
  exec("yarn --version")
  // ok: nerla-exec-template
  return pattern.exec(`${dir}/x`)
}
