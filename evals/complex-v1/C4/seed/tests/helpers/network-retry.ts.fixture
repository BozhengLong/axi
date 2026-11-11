import { APIClient } from "../../src/api/client.ts";
import { streamFixture } from "../fixtures.ts";

const first = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("unused") });
const port = first.port;
first.stop(true);
let server: ReturnType<typeof Bun.serve> | undefined;
let calls = 0;
const delays: number[] = [], codes: string[] = [];
const client = new APIClient({ url: `http://127.0.0.1:${port}/v1/messages`, apiKey: "fake-local", model: "fake", timeoutMs: 1000 }, "", {
  fetch: (async (...args: Parameters<typeof fetch>) => {
    calls++;
    try { return await fetch(...args); }
    catch (error) { codes.push(String((error as { code?: string }).code)); throw error; }
  }) as typeof fetch,
  sleep: async ms => {
    delays.push(ms);
    if (process.argv[2] === "recover" && !server) server = Bun.serve({ hostname: "127.0.0.1", port, fetch: () => new Response(streamFixture(), { headers: { "content-type": "text/event-stream" } }) });
  },
});
let complete = false;
try { await client.call([], { effort: "medium", signal: AbortSignal.timeout(5000) }); complete = true; }
catch { /* 持续连接拒绝是本用例的预期条件。 */ }
finally { server?.stop(true); }
console.log(JSON.stringify({ calls, delays, codes, complete }));
