// Cursor adapter: turns Cursor hook payloads into the core's normalized input and
// renders core decisions in Cursor's hook response format.
// Contract: docs/adapter-contract.md.

export const capabilities = { contentHooks: true };

function extractFilePath(payload) {
  const input = payload.tool_input || payload.toolInput || payload.input || {};
  const candidates = [
    payload.file_path,
    payload.filePath,
    payload.path,
    input.path,
    input.file_path,
    input.filePath,
    Array.isArray(input.file_path) ? input.file_path[0] : null,
  ];
  for (const c of candidates) {
    if (typeof c === 'string' && c) return c;
  }
  return null;
}

function extractCommand(payload) {
  const input = payload.tool_input || payload.toolInput || payload.input || {};
  return payload.command || payload.command_line || input.command || '';
}

function extractToolName(payload) {
  return payload.tool_name || payload.toolName || payload.tool || '';
}

export function normalize(event, payload) {
  const ev = event || payload.hook_event_name || '';
  if (ev === 'subagentStart' || ev === 'subagentStop') {
    return {
      event: ev,
      tool: '',
      filePath: null,
      command: '',
      loopCount: payload.loop_count ?? 0,
      agent: payload.subagent_type || '',
      subagentId: payload.subagent_id || null,
      status: payload.status || null,
      durationMs: payload.duration_ms ?? null,
      raw: payload,
    };
  }
  return {
    event: event || payload.hook_event_name || '',
    tool: extractToolName(payload),
    filePath: extractFilePath(payload),
    command: extractCommand(payload),
    loopCount: payload.loop_count ?? 0,
    raw: payload,
  };
}

// Returns { stdout, exitCode }. Cursor reads exit code 2 as "deny".
export function render(event, decision) {
  if (event === 'preToolUse' || event === 'beforeShellExecution') {
    if (decision.permission === 'deny') {
      const body = { permission: 'deny', user_message: decision.message, agent_message: decision.message };
      return { stdout: `${JSON.stringify(body)}\n`, exitCode: 2 };
    }
    return { stdout: `${JSON.stringify({ permission: 'allow' })}\n`, exitCode: 0 };
  }
  if (event === 'stop' && decision.followup) {
    return { stdout: `${JSON.stringify({ followup_message: decision.followup })}\n`, exitCode: 0 };
  }
  return { stdout: '{}\n', exitCode: 0 };
}

// sessionStart runs `status --hook`; Cursor adds additional_context to the agent's context.
export function renderStatus(text) {
  return `${JSON.stringify({ additional_context: text })}\n`;
}
