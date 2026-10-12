/** Both apps implement the same MCP hook input/output contract. No shell runner is needed. */
export function hookConfiguration() {
  return { hooks: Object.fromEntries(['SessionStart', 'UserPromptSubmit', 'PostToolUse'].map(event => [event, [{
    ...(event === 'PostToolUse' ? { matcher: '^(Bash|PowerShell|apply_patch|Edit|Write|Read|Glob|Grep|WebFetch|WebSearch)$' } : {}),
    hooks: [{ type: 'mcp_tool', server: 'patchwork', tool: 'check_board', timeout: 5,
      input: { session_id: '${session_id}', hook_event_name: '${hook_event_name}' } }],
  }]])) };
}

export function connectionConfiguration(client: string, url: string, token: string) {
  return client === 'codex'
    ? `[mcp_servers.patchwork]\nurl = ${JSON.stringify(url)}\nhttp_headers = { Authorization = ${JSON.stringify('Bearer ' + token)} }`
    : JSON.stringify({ mcpServers: { patchwork: { type:'http', url, headers:{Authorization:`Bearer ${token}`} } } }, null, 2);
}
