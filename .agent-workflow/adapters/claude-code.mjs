// Claude Code adapter. Hook payloads arrive as JSON on stdin; a block is exit code 2 with the
// reason on stderr, and Stop is continued with {"decision":"block","reason":...}.
// Contract: docs/adapter-contract.md.
export const capabilities = { contentHooks: true };

const asString = (v) => (typeof v === 'string' ? v : '');

export function normalize(event, payload) {
  const ev = event || ({ PreToolUse: 'preToolUse', PostToolUse: 'afterFileEdit', Stop: 'stop', SessionStart: 'sessionStart', SubagentStart: 'subagentStart', SubagentStop: 'subagentStop' }[payload.hook_event_name] || '');
  if (ev === 'subagentStart' || ev === 'subagentStop') {
    return {
      event: ev,
      tool: '',
      filePath: null,
      command: '',
      loopCount: payload.stop_hook_active ? 1 : 0,
      agent: payload.agent_type || '',
      subagentId: payload.agent_id || null,
      status: payload.status || (ev === 'subagentStop' ? 'completed' : null),
      durationMs: null,
      raw: payload,
    };
  }
  const input = payload.tool_input || {};
  return {
    event: event || ({ PreToolUse: 'preToolUse', PostToolUse: 'afterFileEdit', Stop: 'stop', SessionStart: 'sessionStart' }[payload.hook_event_name] || ''),
    tool: asString(payload.tool_name),
    filePath: asString(input.file_path) || asString(input.notebook_path) || asString(input.path) || null,
    command: asString(input.command),
    loopCount: payload.stop_hook_active ? 1 : 0,
    raw: payload,
  };
}

export function render(event, decision) {
  if ((event === 'preToolUse' || event === 'beforeShellExecution') && decision.permission === 'deny') {
    return { stdout: '', stderr: `${decision.message}\n`, exitCode: 2 };
  }
  if (event === 'stop' && decision.followup) {
    return { stdout: `${JSON.stringify({ decision: 'block', reason: decision.followup })}\n`, exitCode: 0 };
  }
  return { stdout: '', exitCode: 0 };
}

export function renderStatus(text) {
  return `${JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: text } })}\n`;
}
