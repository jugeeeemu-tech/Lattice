#!/usr/bin/env node

import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

function sortByKey(items, keyBuilder) {
  return [...items].sort((left, right) => keyBuilder(left).localeCompare(keyBuilder(right)));
}

function sortObject(value) {
  return Object.fromEntries(
    Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
  );
}

function normalizeActual(snapshot) {
  const deviceLabelById = new Map(snapshot.devices.map((device) => [device.id, device.label]));
  const devices = sortByKey(
    snapshot.devices.map((device) => ({
      depth: device.depth,
      deployment_type: device.deployment_type,
      device_role: device.device_role,
      label: device.label,
    })),
    (device) => device.label
  );

  const links = sortByKey(
    snapshot.links.map((link) => {
      const leftLabel = deviceLabelById.get(link.local_device_id) ?? link.local_device_id;
      const rightLabel = deviceLabelById.get(link.remote_device_id) ?? link.remote_device_id;
      const leftKey = `${leftLabel}::${link.local_interface}`;
      const rightKey = `${rightLabel}::${link.remote_interface}`;

      if (leftKey <= rightKey) {
        return {
          local_interface: link.local_interface,
          local_label: leftLabel,
          protocol: link.protocol,
          remote_interface: link.remote_interface,
          remote_label: rightLabel,
        };
      }

      return {
        local_interface: link.remote_interface,
        local_label: rightLabel,
        protocol: link.protocol,
        remote_interface: link.local_interface,
        remote_label: leftLabel,
      };
    }),
    (link) =>
      `${link.local_label}:${link.local_interface}:${link.remote_label}:${link.remote_interface}:${link.protocol}`
  );

  const rowById = new Map(snapshot.tree_rows.map((row) => [row.id, row]));
  const parentByChild = new Map(snapshot.tree_edges.map((edge) => [edge.child_row_id, edge.parent_row_id]));
  const normalizedRowIdByOriginal = new Map();

  function normalizedRowId(rowId) {
    if (normalizedRowIdByOriginal.has(rowId)) {
      return normalizedRowIdByOriginal.get(rowId);
    }

    const row = rowById.get(rowId);
    if (!row) {
      return rowId;
    }

    const parentRowId = parentByChild.get(rowId);
    const value = parentRowId
      ? `${normalizedRowId(parentRowId)}/${row.label}`
      : `seed/${row.label}`;
    normalizedRowIdByOriginal.set(rowId, value);
    return value;
  }

  const treeRows = sortByKey(
    snapshot.tree_rows.map((row) => ({
      device_label: deviceLabelById.get(row.device_id) ?? row.device_id,
      id: normalizedRowId(row.id),
      label: row.label,
    })),
    (row) => row.id
  );

  const treeEdges = sortByKey(
    snapshot.tree_edges.map((edge) => ({
      child_row_id: normalizedRowId(edge.child_row_id),
      parent_row_id: normalizedRowId(edge.parent_row_id),
    })),
    (edge) => `${edge.parent_row_id}/${edge.child_row_id}`
  );

  const primaryRowByLabel = sortObject(
    Object.fromEntries(
      Object.entries(snapshot.primary_row_by_device).map(([deviceId, rowId]) => [
        deviceLabelById.get(deviceId) ?? deviceId,
        normalizedRowId(rowId),
      ])
    )
  );

  const rootDeviceLabels = sortByKey(
    (snapshot.root_device_ids ?? []).map((deviceId) => deviceLabelById.get(deviceId) ?? deviceId),
    (label) => label
  );

  const deviceRelationsByLabel = sortObject(
    Object.fromEntries(
      Object.entries(snapshot.device_relations ?? {}).map(([deviceId, relations]) => {
        const label = deviceLabelById.get(deviceId) ?? deviceId;
        const normalizeIds = (ids = []) =>
          sortByKey(ids.map((id) => deviceLabelById.get(id) ?? id), (entry) => entry);
        return [
          label,
          {
            children: normalizeIds(relations.children),
            parents: normalizeIds(relations.parents),
            peers: normalizeIds(relations.peers),
          },
        ];
      })
    )
  );

  return {
    device_relations_by_label: deviceRelationsByLabel,
    devices,
    discovery_status: {
      state: snapshot.discovery_status.state,
    },
    links,
    primary_row_by_label: primaryRowByLabel,
    root_device_labels: rootDeviceLabels,
    tree_edges: treeEdges,
    tree_rows: treeRows,
  };
}

async function readJson(filePath) {
  const raw = await readFile(filePath, 'utf8');
  return JSON.parse(raw);
}

async function main() {
  const args = process.argv.slice(2);
  const actualPath = args[args.indexOf('--actual') + 1];
  const expectedPath = args[args.indexOf('--expected') + 1];
  const outDir = args[args.indexOf('--out-dir') + 1];

  if (!actualPath || !expectedPath || !outDir) {
    throw new Error(
      'Usage: compare-snapshot.mjs --actual <file> --expected <file> --out-dir <dir>'
    );
  }

  const actualSnapshot = await readJson(actualPath);
  const expectedSnapshot = await readJson(expectedPath);
  const normalizedActual = normalizeActual(actualSnapshot);
  const normalizedExpected = expectedSnapshot;

  const actualNormalizedPath = path.join(outDir, 'actual.normalized.snapshot.json');
  const diffPath = path.join(outDir, 'snapshot.diff.json');

  await writeFile(actualNormalizedPath, `${JSON.stringify(normalizedActual, null, 2)}\n`, 'utf8');

  try {
    assert.deepStrictEqual(normalizedActual, normalizedExpected);
    await writeFile(
      diffPath,
      `${JSON.stringify({ status: 'matched' }, null, 2)}\n`,
      'utf8'
    );
  } catch (error) {
    await writeFile(
      diffPath,
      `${JSON.stringify(
        {
          actual: normalizedActual,
          error: error instanceof Error ? error.message : String(error),
          expected: normalizedExpected,
          status: 'mismatched',
        },
        null,
        2
      )}\n`,
      'utf8'
    );
    throw error;
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
