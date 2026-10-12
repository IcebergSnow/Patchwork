// Encoded argv keeps startup paths with quotes/spaces safe on Windows and macOS.
export function startupCommand(entry, file) {
  const args = Buffer.from(
    JSON.stringify([entry, "hook", "--connection", file]),
  ).toString("base64");
  return `node -e "const r=require('node:child_process').spawnSync(process.execPath,JSON.parse(Buffer.from('${args}','base64').toString()),{stdio:'inherit'});process.exit(r.status===null?1:r.status)"`;
}
export function hookConfiguration(entry, file) {
  return {
    hooks: {
      SessionStart: [
        {
          hooks: [
            {
              type: "command",
              command: startupCommand(entry, file),
              timeout: 60,
            },
          ],
        },
      ],
      ...Object.fromEntries(
        ["UserPromptSubmit", "PostToolUse"].map((event) => [
          event,
          [
            {
              ...(event === "PostToolUse"
                ? {
                    matcher:
                      "^(Bash|PowerShell|apply_patch|Edit|Write|Read|Glob|Grep)$",
                  }
                : {}),
              hooks: [
                {
                  type: "mcp_tool",
                  server: "patchwork",
                  tool: "check_board",
                  timeout: 60,
                  input: {
                    session_id: "${session_id}",
                    hook_event_name: "${hook_event_name}",
                  },
                },
              ],
            },
          ],
        ]),
      ),
    },
  };
}
export const serverConfiguration = (entry, file) => ({
  command: process.execPath,
  args: [entry, "mcp", "--connection", file],
});
