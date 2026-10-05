/**
 * Per-worker setup. The CLI tethers to CLAUDE_PID automatically (decision
 * 0035); a suite run from inside Claude Code inherits it, and every lease a
 * test makes would then outlive the test and depend on the agent. Tests opt
 * into a tether explicitly (--holder-pid) or not at all.
 */
delete process.env.CLAUDE_PID;
process.env.BACKLOT_TETHER = 'off';

// The load budget stays ON in tests (its accounting is what they exercise),
// but its machine gates are opened: a box shared with other work must not
// make an unrelated test queue on the load average or free memory. The
// budget tests set them explicitly.
process.env.BACKLOT_BUDGET_LOAD_PER_CORE ??= '1000000';
process.env.BACKLOT_BUDGET_RESERVE ??= '0';
