/**
 * FocusView — the agent's page, opened from the rail agent. One job: what matters today.
 * Native: the brief, Needs you, Your three, Waiting on, goals and tasks (Focus/page). No iframe.
 */
import { FocusPage } from "./page/FocusPage";
import { focusEnv } from "./page/focusApi";
import { useFocusFeed } from "./focusBridge";
import { requestMemoryEntity } from "../../lib/memoryNav";
import { switchToMemoryTab } from "../../lib/ensureDefaultChatTab";

/** Goal entity chips open the Memory page (desktop only; the web shows them as plain chips). */
focusEnv.openEntity = (ref) => {
  const [type, ...rest] = ref.split("/");
  switchToMemoryTab();
  requestMemoryEntity({ id: ref, type: type.replace(/s$/, ""), label: rest.join("/").replace(/-/g, " "), description: "", props: {} });
};

export function FocusView() {
  return (
    <div className="focus-view" data-testid="focus-view">
      <FocusPage useFeed={useFocusFeed} />
    </div>
  );
}
