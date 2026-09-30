import "./ClaudeSetupTokenTerminalExample.css";

/** Visual example of the token line users should copy from Terminal after sign-in. */
export function ClaudeSetupTokenTerminalExample() {
  return (
    <div
      className="claude-token-terminal-example"
      role="img"
      aria-label="Example Terminal output showing a line starting with sk-ant-oat01- to copy"
    >
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
