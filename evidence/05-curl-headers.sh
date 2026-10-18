#!/usr/bin/env bash
# Reproduces evidence/05-curl-headers.txt. Requires `pnpm server` running on :3333.
U=${MCP_URL:-http://127.0.0.1:3333/mcp}
H=(-H 'content-type: application/json' -H 'accept: application/json, text/event-stream')
INIT='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"curl","version":"0"}}}'
LIST='{"jsonrpc":"2.0","id":2,"method":"tools/list"}'
echo '## A. initialize, no Origin'; curl -s -i -X POST "$U" "${H[@]}" -d "$INIT"; echo; echo
echo '## B. initialize, Origin: https://evil.example'; curl -s -i -X POST "$U" -H 'origin: https://evil.example' "${H[@]}" -d "$INIT"; echo; echo
echo '## C. tools/list with no session id'; curl -s -i -X POST "$U" -H 'mcp-protocol-version: 2025-11-25' "${H[@]}" -d "$LIST"; echo; echo
SID=$(curl -s -D - -o /dev/null -X POST "$U" "${H[@]}" -d "$INIT" | awk -F': ' 'tolower($1)=="mcp-session-id"{print $2}' | tr -d '\r')
echo "## D. tools/list with session $SID but MCP-Protocol-Version: 1999-01-01"; curl -s -i -X POST "$U" -H "mcp-session-id: $SID" -H 'mcp-protocol-version: 1999-01-01' "${H[@]}" -d "$LIST"; echo; echo
echo '## E. DELETE session, then reuse it'
curl -s -o /dev/null -w 'DELETE -> %{http_code}\n' -X DELETE "$U" -H "mcp-session-id: $SID" -H 'mcp-protocol-version: 2025-11-25'
curl -s -o /dev/null -w 'reuse after DELETE -> %{http_code}\n' -X POST "$U" -H "mcp-session-id: $SID" -H 'mcp-protocol-version: 2025-11-25' "${H[@]}" -d "$LIST"
