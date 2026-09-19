import "./ClaudeSetupTokenTerminalExample.css";

/** Visual example of the token line users should copy from Terminal after `claude setup-token`. */
export function ClaudeSetupTokenTerminalExample() {
  return (
    <div className="claude-token-terminal-example" aria-hidden="true">
      <div className="claude-token-terminal-example__bar">Terminal</div>
      <pre className="claude-token-terminal-example__body">
        {`Sign in complete!

Your token (copy this whole line):

`}
        <span className="claude-token-terminal-example__highlight">
          sk-ant-oat01-••••••••••••••••
        </span>
      </pre>
    </div>
  );
}
