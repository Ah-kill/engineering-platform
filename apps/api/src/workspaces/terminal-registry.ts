/**
 * How many browser terminals the platform itself has open per workspace. The container
 * cleanup uses it: processes inside the container can imitate a terminal shell, but they
 * cannot change this count, so any surplus means something is pretending.
 */
let counter: (workspaceId: string) => number = () => 0;

export function registerTerminalCounter(fn: (workspaceId: string) => number): void {
  counter = fn;
}

export function openTerminals(workspaceId: string): number {
  return counter(workspaceId);
}
