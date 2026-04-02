#!/usr/bin/env node

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { deriveScenario, listScenarioNames, listSuites } from './scenario-registry.mjs';

function parseArgs(argv) {
  const args = {
    outDir: null,
    scenario: null,
    serverPort: 18080,
    suite: null,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--scenario') {
      args.scenario = argv[index + 1] ?? null;
      index += 1;
      continue;
    }
    if (value === '--out') {
      args.outDir = argv[index + 1] ?? null;
      index += 1;
      continue;
    }
    if (value === '--server-port') {
      args.serverPort = Number(argv[index + 1] ?? '18080');
      index += 1;
      continue;
    }
    if (value === '--list-suite') {
      args.suite = argv[index + 1] ?? null;
      index += 1;
      continue;
    }
    if (value === '--list-suites') {
      args.listSuites = true;
      continue;
    }
    throw new Error(`Unknown argument: ${value}`);
  }

  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.listSuites) {
    console.log(listSuites().join('\n'));
    return;
  }

  if (args.suite) {
    console.log(listScenarioNames(args.suite).join('\n'));
    return;
  }

  if (!args.scenario || !args.outDir) {
    throw new Error('Usage: render-scenario.mjs --scenario <name> --out <dir> [--server-port <port>]');
  }

  const outDir = path.resolve(args.outDir);
  await mkdir(outDir, { recursive: true });

  const { expectedSnapshot, metadata, rendered, rules } = deriveScenario(args.scenario, {
    serverPort: args.serverPort,
  });

  await writeFile(path.join(outDir, 'topology.clab.yml'), rendered.topologyYaml, 'utf8');
  await writeFile(path.join(outDir, 'lattice.ci.yaml'), rendered.latticeConfigYaml, 'utf8');
  await writeFile(
    path.join(outDir, 'expected.snapshot.json'),
    `${JSON.stringify(expectedSnapshot, null, 2)}\n`,
    'utf8'
  );
  await writeFile(
    path.join(outDir, 'expected.rules.json'),
    `${JSON.stringify(rules, null, 2)}\n`,
    'utf8'
  );
  await writeFile(
    path.join(outDir, 'scenario.metadata.json'),
    `${JSON.stringify(metadata, null, 2)}\n`,
    'utf8'
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
