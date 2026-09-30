/** Focus tab icon — the same agent as the rail, so its Replay animation shows on the tab too. */
import { AgentGlyph } from "../Agent/AgentGlyph";
import { useAgentWork } from "../Agent/agentWork";
import { useAgentIdentity } from "../Agent/agentIdentityStore";

export function FocusTabIcon() {
  const work = useAgentWork();
  const look = useAgentIdentity((s) => s.look);
  return <AgentGlyph size={look === "papr" ? 14 : 16} state={work.state} className="tab__agent" />;
}
