const test = require("node:test");
const assert = require("node:assert/strict");

import { parseSubgraphManifest, summarizeSubgraphManifest } from "../lib/subgraph";

test("parseSubgraphManifest handles a common YAML subgraph layout", () => {
  const manifest = parseSubgraphManifest(`
specVersion: 0.0.5
description: Demo
schema:
  file: ./schema.graphql
dataSources:
  - kind: ethereum/contract
    name: DemoSource
    network: mainnet
    source:
      address: "0x1234"
      startBlock: 123
    mapping:
      eventHandlers:
        - event: Transfer(indexed address,indexed address,uint256)
          handler: handleTransfer
templates:
  - kind: ethereum/contract
    name: DemoTemplate
    network: base
`);

  const summary = summarizeSubgraphManifest(manifest, "/tmp/subgraph.yaml");
  assert.equal((summary.totals as Record<string, unknown>).dataSources, 1);
  assert.equal((summary.totals as Record<string, unknown>).templates, 1);
  assert.deepEqual(summary.networks, ["mainnet", "base"]);
});
