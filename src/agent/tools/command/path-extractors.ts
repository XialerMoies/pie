export type {
  CommandPathArg,
  PathExtractorContext,
  PathOperation,
} from "./path-extractors/core.js"
import {
  PATH_COMMANDS,
  cdExtractor,
  defaultDotExtractor,
  simpleExtractor,
  type CommandPathArg,
  type PathCommand,
  type PathExtractor,
  type PathExtractorContext,
} from "./path-extractors/core.js"
import {
  cpExtractor,
  findExtractor,
  findstrExtractor,
  mvExtractor,
  powershellContentExtractor,
  sortExtractor,
} from "./path-extractors/filesystem.js"
import {
  grepExtractor,
  jqExtractor,
  rgExtractor,
  sedExtractor,
} from "./path-extractors/search.js"
import { gitExtractor, tarExtractor } from "./path-extractors/archive.js"

const PATH_EXTRACTORS: Record<PathCommand, PathExtractor> = {
  cd: cdExtractor,
  pushd: cdExtractor,
  ls: defaultDotExtractor,
  dir: defaultDotExtractor,
  find: findExtractor,
  findstr: findstrExtractor,
  cat: simpleExtractor,
  type: simpleExtractor,
  head: simpleExtractor,
  tail: simpleExtractor,
  more: simpleExtractor,
  sort: sortExtractor,
  uniq: simpleExtractor,
  wc: simpleExtractor,
  cut: simpleExtractor,
  paste: simpleExtractor,
  column: simpleExtractor,
  tr: simpleExtractor,
  file: simpleExtractor,
  stat: simpleExtractor,
  diff: simpleExtractor,
  fc: simpleExtractor,
  awk: simpleExtractor,
  strings: simpleExtractor,
  hexdump: simpleExtractor,
  od: simpleExtractor,
  base64: simpleExtractor,
  nl: simpleExtractor,
  grep: grepExtractor,
  rg: rgExtractor,
  sed: sedExtractor,
  jq: jqExtractor,
  git: gitExtractor,
  tar: tarExtractor,
  touch: simpleExtractor,
  mkdir: simpleExtractor,
  "new-item": powershellContentExtractor,
  cp: cpExtractor,
  copy: cpExtractor,
  mv: mvExtractor,
  move: mvExtractor,
  rm: simpleExtractor,
  rmdir: simpleExtractor,
  del: simpleExtractor,
  erase: simpleExtractor,
  rd: simpleExtractor,
  "remove-item": simpleExtractor,
  "set-content": powershellContentExtractor,
  "add-content": powershellContentExtractor,
  "out-file": powershellContentExtractor,
}

export function extractCommandPathArgs(command: string, args: string[], context: PathExtractorContext = {}): CommandPathArg[] {
  const pathCommand = command.toLowerCase() as PathCommand
  if (!PATH_COMMANDS.has(pathCommand)) return []
  return PATH_EXTRACTORS[pathCommand](args, pathCommand, context)
}
