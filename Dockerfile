# base64hub-mcp as a container image: an MCP server over stdio.
#   docker run --rm -i ghcr.io/base64hub-com/base64hub-mcp
FROM node:22-alpine@sha256:1314fb30ec37592d5845e5a160d522c0e680972aa534549940b8d73bde88481a
WORKDIR /app
COPY package.json LICENSE core.js protocol.js server.js ./
COPY bin ./bin
USER node
ENTRYPOINT ["node", "/app/bin/base64hub-mcp.js"]
