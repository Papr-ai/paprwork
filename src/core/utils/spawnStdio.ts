/**
 * Default stdio for shell spawns in the Gateway child process.
 *
 * stdin must be "ignore" — inheriting the Gateway's stdin can be closed or
 * invalid, which surfaces as EBADF when Node tries to create pipe fds.
 */
export const SPAWN_STDIO_IGNORE_IN: ["ignore", "pipe", "pipe"] = [
  "ignore",
  "pipe",
  "pipe",
];
