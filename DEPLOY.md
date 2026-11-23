# Deploying mcp.base64hub.com

The hosted MCP server is one Cloudflare Worker. Everything happens in the Cloudflare dashboard;
the whole Worker is `worker.js`, generated from `core.js`, `protocol.js` and `http.js`:

```sh
node scripts/build-worker.js
npm test
```

`npm test` fails when `worker.js` is older than its sources.

## 1. Create the Worker

1. **Workers & Pages** → **Create** → **Create Worker** (start from "Hello World").
2. Name it `base64hub-mcp` and select **Deploy**.
3. Select **Edit code**, replace everything in the editor with the contents of `worker.js`, then
   **Deploy**.

The Worker needs no variables, secrets or bindings.

## 2. Custom domain

1. Worker → **Settings** → **Domains & Routes** → **Add** → **Custom domain**.
2. Enter `mcp.base64hub.com` and add it. Cloudflare creates the DNS record and the certificate
   (the `base64hub.com` zone must be on the same account).

## 3. Turn off workers.dev and preview URLs

The `workers.dev` subdomain names the Cloudflare account, so it must not be reachable.

1. Worker → **Settings** → **Domains & Routes**.
2. `workers.dev`: **Disable**.
3. **Preview URLs**: **Disable**.

## 4. Rate limiting (20 requests / 10 s per IP)

Zone `base64hub.com` → **Security** → **Security rules** → **Rate limiting rules**.

- Pro plan or higher: create a rule with `(http.host eq "mcp.base64hub.com")`, characteristics IP,
  20 requests per 10 seconds, action Block for 10 seconds.
- Free plan: a zone has one rate limiting rule and only the URI path can be matched, so the rule
  that protects the API is widened instead. Edit it and set the expression to

  ```
  (starts_with(http.request.uri.path, "/v1/")) or (http.request.uri.path eq "/mcp")
  ```

  The API and the MCP server then share one counter per IP. The site page is `/mcp/`, with a
  trailing slash, so it is not matched.

## 5. Smoke test

```sh
curl -si https://mcp.base64hub.com/ | head -n 5
curl -s https://mcp.base64hub.com/mcp -H 'Content-Type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl","version":"1"}}}'
curl -s https://mcp.base64hub.com/mcp -H 'Content-Type: application/json' -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'
curl -s https://mcp.base64hub.com/mcp -H 'Content-Type: application/json' -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"base64_encode","arguments":{"text":"Hello, hub!"}}}'
curl -s https://mcp.base64hub.com/mcp -H 'Content-Type: application/json' -H 'MCP-Protocol-Version: 2026-07-28' -H 'Mcp-Method: server/discover' -d '{"jsonrpc":"2.0","id":4,"method":"server/discover","params":{"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientCapabilities":{}}}}'
curl -si https://mcp.base64hub.com/mcp | head -n 1
curl -si -X OPTIONS https://mcp.base64hub.com/mcp -H 'Origin: https://example.com' -H 'Access-Control-Request-Method: POST' | head -n 1
```

Expected: `/` returns 302 to `https://base64hub.com/mcp/`, initialize returns the server info with
the package version, tools/list returns three tools, the call returns `SGVsbG8sIGh1YiE=`,
server/discover lists the supported versions, GET returns 405 and the preflight 204.

Then connect a real client:

```sh
claude mcp add --transport http base64hub-remote https://mcp.base64hub.com/mcp
```

Also confirm that the old `*.workers.dev` URL of the Worker no longer answers.

## Updating

Run `node scripts/build-worker.js`, open the Worker → **Edit code**, paste the new `worker.js`,
**Deploy**.
