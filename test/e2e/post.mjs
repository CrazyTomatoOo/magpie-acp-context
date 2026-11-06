// Posts the fixture request to the gateway and writes status + body.
// Bun is the only HTTP client in the test image, so polling and posting share it.
const [url, out] = process.argv.slice(2);
const body = await Bun.file("/tmp/req.json").text();

const headers = { "content-type": "application/json", authorization: "Bearer sk-test" };
// magpie maps X-Magpie-Session (and the clients' own session headers) onto ctx.session.
if (process.env.ACS_SESSION) headers["x-magpie-session"] = process.env.ACS_SESSION;

let status = 0;
let text = "";
try {
  const res = await fetch(url, {
    method: "POST",
    headers,
    body,
    signal: AbortSignal.timeout(120_000),
  });
  status = res.status;
  text = await res.text();
} catch (err) {
  text = `{"error":{"message":"${String(err)}"}}`;
}

await Bun.write(`${out}/response.json`, text);
await Bun.write(`${out}/response.status`, String(status));
console.log(`status=${status}`);
process.exit(status === 200 ? 0 : 1);
