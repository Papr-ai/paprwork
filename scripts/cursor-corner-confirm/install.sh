#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
CURSOR_DIR="${HOME}/.cursor"
HOOKS_DIR="${CURSOR_DIR}/hooks"
DESKTOP_DIR="${CURSOR_DIR}/desktop-confirm"

mkdir -p "${HOOKS_DIR}" "${DESKTOP_DIR}"

install -m 755 "${ROOT}/ask-confirm.py" "${HOOKS_DIR}/ask-confirm.py"
install -m 755 "${ROOT}/confirm-server.py" "${DESKTOP_DIR}/confirm-server.py"

cat > "${DESKTOP_DIR}/启动确认窗.command" << EOF
#!/bin/bash
cd "${DESKTOP_DIR}"
exec python3 confirm-server.py
EOF
chmod +x "${DESKTOP_DIR}/启动确认窗.command"

cat > "${CURSOR_DIR}/hooks.json" << EOF
{
  "version": 1,
  "hooks": {
    "beforeShellExecution": [
      { "command": "python3 ${HOOKS_DIR}/ask-confirm.py" }
    ],
    "beforeMCPExecution": [
      { "command": "python3 ${HOOKS_DIR}/ask-confirm.py" }
    ]
  }
}
EOF

python3 -m py_compile "${HOOKS_DIR}/ask-confirm.py"
python3 -m py_compile "${DESKTOP_DIR}/confirm-server.py"

echo "Installed:"
echo "  ${HOOKS_DIR}/ask-confirm.py"
echo "  ${DESKTOP_DIR}/confirm-server.py"
echo "  ${DESKTOP_DIR}/启动确认窗.command"
echo "  ${CURSOR_DIR}/hooks.json"
echo
echo "Next: double-click ${DESKTOP_DIR}/启动确认窗.command"
echo "Then restart Cursor (Cmd+Q, reopen)."
