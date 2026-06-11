const test = require("node:test");
const assert = require("node:assert/strict");

import { createHttpClient } from "../lib/http";

const apiKey = process.env.INDEXING_CO_STAGING_API_KEY;

test("staging pipeline list is reachable when INDEXING_CO_STAGING_API_KEY is set", { skip: !apiKey }, async () => {
  const client = createHttpClient({
    apiKey,
    baseUrl: process.env.INDEXING_CO_STAGING_BASE_URL || "https://app.indexing.co/dw",
    userAgent: "@indexing/cli/integration-test",
  });

  const response = await client.get("/pipelines");
  assert.ok(response.status >= 200 && response.status < 300);
});
