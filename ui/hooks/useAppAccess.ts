/** Load an app's roles/audiences (memory GET /access via the gateway). */

import { useCallback, useEffect, useState } from "react";
import { fetchAppAccess } from "../utils/appAccessApi";
import type { AppAccess } from "../utils/appRolesModel";

export function useAppAccess(appId: string | null): {
  access: AppAccess | null;
  loading: boolean;
  setAccess: (a: AppAccess) => void;
} {
  const [access, setAccess] = useState<AppAccess | null>(null);
  const [loading, setLoading] = useState(Boolean(appId));
  useEffect(() => {
    if (!appId) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    fetchAppAccess(appId)
      .then((a) => !cancelled && setAccess(a))
      .catch(() => !cancelled && setAccess(null))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [appId]);
  return { access, loading, setAccess: useCallback((a: AppAccess) => setAccess(a), []) };
}
