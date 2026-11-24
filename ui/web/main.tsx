/**
 * apps.papr.ai Focus: the Papr Work Focus page, in the browser. Same components; data from
 * /focus-api (the app host, with your session), chat hands off to the desktop app.
 */
import { createRoot } from "react-dom/client";
import { FocusPage } from "../components/Focus/page/FocusPage";
import { focusEnv } from "../components/Focus/page/focusApi";
import { useWebFeed } from "./useWebFeed";
import { openInDesktop } from "./desktop";

focusEnv.base = () => "/focus-api";
focusEnv.web = true;
focusEnv.openChat = openInDesktop;

const el = document.getElementById("focus-root");
if (el) createRoot(el).render(<FocusPage useFeed={useWebFeed} />);
