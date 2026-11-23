# Publishing base64hub-mcp

Owner checklist for a release. The order matters: the MCP Registry only stores metadata and checks
that the npm package exists and carries `"mcpName": "com.base64hub/mcp"`, so npm comes first.

## 0. Before every release

```sh
npm test
git log --format='%an <%ae>' | sort -u
npm pack --dry-run
```

Also run the identity grep from the "Identity" section of the base64hub software contract; it must
print nothing. The log shows only `base64hub <g@base64hub.com>`, and the tarball lists exactly
`LICENSE`, `README.md`, `package.json`, `bin/base64hub-mcp.js`, `core.js`, `protocol.js`, `server.js`.

For a new version, bump `version` in `package.json` and both `version` fields in `server.json`
(top level and `packages[0]`); the tests fail if they disagree.

The hosted server changes with the package: after `node scripts/build-worker.js`, paste the new
`worker.js` into the Cloudflare Worker (see `DEPLOY.md`) before publishing `server.json`, so the
`remotes` entry never points at an older build.

## 1. npm

Log in as the base64hub npm account (2FA on), then publish:

```sh
npm login
npm whoami
npm publish --access public
```

Check [npmjs.com/package/base64hub-mcp](https://www.npmjs.com/package/base64hub-mcp) and run
`npx -y base64hub-mcp --version` from a clean directory.

## 2. Domain verification for `com.base64hub/*` (HTTP method)

The server name `com.base64hub/mcp` is proven by a public key served from base64hub.com. The key pair
is made once, on the owner's machine, outside this repository. Never commit the private key; the
`.gitignore` here blocks `key.pem` and `mcp-registry-auth` as a safety net.

OpenSSL 3 is required for Ed25519 (on macOS use Homebrew `openssl@3`, the system LibreSSL lacks it):

```sh
mkdir -p ~/.config/base64hub && cd ~/.config/base64hub
openssl genpkey -algorithm Ed25519 -out key.pem
chmod 600 key.pem
PUBLIC_KEY="$(openssl pkey -in key.pem -pubout -outform DER | tail -c 32 | base64)"
echo "v=MCPv1; k=ed25519; p=${PUBLIC_KEY}" > mcp-registry-auth
cat mcp-registry-auth
```

The file is one line of plain text in exactly this format, with the raw 32-byte Ed25519 public key in
standard Base64 (44 characters, ending in `=`):

```
v=MCPv1; k=ed25519; p=<44-character base64 public key>
```

Publish it at `https://base64hub.com/.well-known/mcp-registry-auth`: copy it to
`static/.well-known/mcp-registry-auth` in the website repo (next to `security.txt`), build and deploy.
The registry fetches it with `GET`, `Accept: text/plain` and `User-Agent: mcp-registry/1.0` from
Google Cloud addresses, wants `200 OK` with no redirect, at most 4096 bytes, within 10 seconds.
The site sits behind Cloudflare: if Bot Fight Mode, a WAF rule or a challenge page can hit non-browser
clients, add a skip rule for the path `/.well-known/mcp-registry-auth`. Check it the way the registry
sees it:

```sh
curl -sS -H 'Accept: text/plain' -A 'mcp-registry/1.0' -w '\n%{http_code}\n' https://base64hub.com/.well-known/mcp-registry-auth
```

The public key file may stay online; it is needed again for every future login.

## 3. MCP Registry

Install the publisher CLI (Homebrew, or the release binary from
[github.com/modelcontextprotocol/registry/releases](https://github.com/modelcontextprotocol/registry/releases)):

```sh
brew install mcp-publisher
```

Log in with the private key (hex of the 32-byte seed, derived from `key.pem`), then publish from this
directory, which holds `server.json`:

```sh
PRIVATE_KEY="$(openssl pkey -in ~/.config/base64hub/key.pem -noout -text | grep -A3 'priv:' | tail -n +2 | tr -d ' :\n')"
mcp-publisher login http --domain base64hub.com --private-key "${PRIVATE_KEY}"
unset PRIVATE_KEY
mcp-publisher validate
mcp-publisher publish
```

Verify:

```sh
curl -s 'https://registry.modelcontextprotocol.io/v0.1/servers?search=com.base64hub/mcp'
```

The login token is stored in `~/.config/mcp-publisher/token.json`; `mcp-publisher logout` removes
it (older versions left `.mcpregistry_*` files in the current directory, which are git-ignored here).

`server.json` follows the schema at
`https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json`. If `mcp-publisher`
reports a newer schema, run `mcp-publisher init` in a scratch directory and compare.

## 4. Other directories

| Directory | How to list | Needs a public GitHub repo |
|---|---|---|
| [Glama](https://glama.ai/mcp/servers) | **Add MCP Server**, give the GitHub URL, name and description. An optional `glama.json` in the repo root sets display name, category and build spec. Automated checks (license, security scan, health test). | Yes, GitHub only |
| [mcp.so](https://mcp.so/submit) | Submit form, type MCP Server, **Repository URL** is required. Free review, or a paid option that publishes at once. | Yes |
| [mcpservers.org](https://mcpservers.org/submit) | Form with name, category, short description, "Repository, Website or Documentation" URL, optional Official MCP Registry name (`com.base64hub/mcp`), contact email. Free review takes up to two weeks. | No: `https://base64hub.com/mcp/` works as the URL |
| [Smithery](https://smithery.ai/new) | Local stdio servers are listed as an MCPB bundle (`server.mcpb`) uploaded to Smithery; the URL method is for remote Streamable HTTP servers only. Needs an `.mcpb` bundle built from this package first. | No, but an MCPB bundle is needed |
| [PulseMCP](https://www.pulsemcp.com/submit) | New submissions were paused at the time of writing (October 2026); check the submit page again. | Check when reopened |

Use the same name and description everywhere: **base64hub** (`base64hub-mcp`), "Exact Base64 for AI
agents: encode, decode and validate (standard, URL-safe, data URIs)." Link the landing page
[base64hub.com/mcp/](https://base64hub.com/mcp/) and the docs
[base64hub.com/docs/mcp/](https://base64hub.com/docs/mcp/). Once a listing is live, add its URL to
`data/apps.yaml` in the website repo.
