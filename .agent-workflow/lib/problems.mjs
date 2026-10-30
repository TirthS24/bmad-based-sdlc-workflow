// A postcondition problem: the rule that failed, what was found, what the rule expects, and text
// that would pass. Checks return a list of these; an empty list means the check passed.
export const problem = (rule, found, expected, example) => ({ rule, found, expected, example });

export const formatProblem = (p) => `✗ ${p.rule}: found ${p.found}; expected ${p.expected}. Example: ${p.example}`;

export const formatProblems = (list) => list.map(formatProblem).join('\n');
