import { PaprLogoMark } from "../common/PaprLogoMark";
import { openPaprPlanSettings } from "../../utils/cloudMemoryStatus";
import { useCloudMemoryStatusStore } from "../../stores/cloudMemoryStatusStore";
import "./CloudMemoryStatusChip.css";

interface CloudMemoryStatusChipProps {
  compact?: boolean;
}

export function CloudMemoryStatusChip({ compact = false }: CloudMemoryStatusChipProps) {
  const status = useCloudMemoryStatusStore((state) => state.status);
  if (!status) return null;

  return (
    <button
      type="button"
      className={`cloud-memory-status${compact ? " cloud-memory-status--compact" : ""}`}
      data-level={status.level}
      onClick={openPaprPlanSettings}
      title={status.detail}
    >
      <PaprLogoMark size={compact ? 11 : 12} />
      <span className="cloud-memory-status__copy">
        <span className="cloud-memory-status__label">{status.label}</span>
        {!compact ? (
          <span className="cloud-memory-status__detail">{status.detail}</span>
        ) : null}
      </span>
    </button>
  );
}
