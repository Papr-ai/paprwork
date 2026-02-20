import { useMemo } from "react";
import { useApp } from "../../hooks/useApp";
import "./MiniAppView.css";

interface MiniAppViewProps {
  appId: string;
}

export function MiniAppView({ appId }: MiniAppViewProps) {
  const { reloadKey } = useApp(appId);

  const src = useMemo(() => {
    const host = import.meta.env.VITE_GATEWAY_HOST || "localhost";
    const port = import.meta.env.VITE_GATEWAY_PORT || "18789";
    return `http://${host}:${port}/apps/${appId}/index.html`;
  }, [appId]);

  return (
    <div className="mini-app-view">
      <iframe
        key={`${appId}-${reloadKey}`}
        className="mini-app-view__frame"
        src={src}
        title={`mini-app-${appId}`}
        sandbox="allow-scripts allow-forms allow-modals allow-same-origin allow-popups allow-popups-to-escape-sandbox"
      />
    </div>
  );
}
