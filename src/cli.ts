#!/usr/bin/env node
import { describe, type Report, whomade } from './index.ts';
import { serve } from './mcp.ts';
import { load, version } from './node.ts';

const USAGE = `Usage: whomade <image or url>... [--json]
       whomade mcp          Start the MCP server (stdio)

Options:
  --json         One JSON report per line
  -v, --version  Print the version
  -h, --help     Print this help`;

const args = process.argv.slice(2);
const sources = args.filter((a) => !a.startsWith('-'));

if (args[0] === 'mcp') {
  serve();
} else if (args.includes('-v') || args.includes('--version')) {
  console.log(version);
} else if (args.includes('-h') || args.includes('--help')) {
  console.log(USAGE);
} else if (!sources.length) {
  console.error(USAGE);
  process.exitCode = 1;
} else {
  const json = args.includes('--json');
  for (const source of sources) {
    try {
      const report = await whomade(await load(source));
      console.log(json ? JSON.stringify({ source, ...report }) : format(source, report));
    } catch (e) {
      process.exitCode = 1;
      const message = (e as Error).message;
      if (json) console.log(JSON.stringify({ source, error: message }));
      else console.error(`${source}\n  error: ${message}\n`);
    }
  }
}

function format(source: string, report: Report): string {
  const lines = report.evidence.map((e) => `  ${e.confidence.padEnd(8)} ${e.source.padEnd(4)}  ${e.detail}`);
  return [source, `  ${describe(report)}`, ...lines, ''].join('\n');
}
