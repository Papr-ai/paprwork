import { useCallback, useEffect, useState } from "react";
import { gateway } from "../src/lib/gateway";

export interface SkillRecord {
  id: string;
  name: string;
  description: string;
  content: string;
  enabled: boolean;
  assignedAgentIds: string[];
  createdAt: string;
  updatedAt: string;
  source?: "local" | "preloaded" | "clawhub" | "skills.sh";
  externalId?: string;
}

export interface CatalogSkill {
  id: string;
  name: string;
  description: string;
  content: string;
  source: "clawhub" | "skills.sh";
  url?: string;
  category?: string;
  tags?: string[];
  installs?: number;
}

export function useSkills() {
  const [skills, setSkills] = useState<SkillRecord[]>([]);
  const [catalogSkills, setCatalogSkills] = useState<CatalogSkill[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadSkills = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await gateway.send("skill:list");
      const raw = (response.data as SkillRecord[]) ?? [];
      setSkills(
        raw.map((skill) => ({
          ...skill,
          enabled: skill.enabled ?? true,
          assignedAgentIds: Array.isArray(skill.assignedAgentIds)
            ? skill.assignedAgentIds
            : [],
        })),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load skills");
    } finally {
      setLoading(false);
    }
  }, []);

  const loadCatalogSkills = useCallback(async () => {
    setError(null);
    try {
      const response = await gateway.send("skill:catalog");
      setCatalogSkills((response.data as CatalogSkill[]) ?? []);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to load catalog skills",
      );
    }
  }, []);

  const createSkill = useCallback(
    async (name: string, description: string, content: string) => {
      const response = await gateway.send("skill:create", {
        name,
        description,
        content,
      });
      const skill = response.data as SkillRecord;
      setSkills((prev) => [
        skill,
        ...prev.filter((item) => item.id !== skill.id),
      ]);
      return skill;
    },
    [],
  );

  const deleteSkill = useCallback(async (skillId: string) => {
    await gateway.send("skill:delete", { skillId });
    setSkills((prev) => prev.filter((skill) => skill.id !== skillId));
  }, []);

  const installCatalogSkill = useCallback(
    async (source: "clawhub" | "skills.sh", catalogId: string) => {
      const response = await gateway.send("skill:install-catalog", {
        source,
        catalogId,
      });
      const installed = response.data as SkillRecord;
      setSkills((prev) => [
        installed,
        ...prev.filter((s) => s.id !== installed.id),
      ]);
      return installed;
    },
    [],
  );

  const toggleSkillEnabled = useCallback(
    async (skillId: string, enabled: boolean) => {
      const response = await gateway.send("skill:toggle-enabled", {
        skillId,
        enabled,
      });
      const updated = response.data as SkillRecord;
      setSkills((prev) =>
        prev.map((item) => (item.id === updated.id ? updated : item)),
      );
      return updated;
    },
    [],
  );

  const setSkillAccess = useCallback(
    async (skillId: string, agentIds: string[]) => {
      const response = await gateway.send("skill:set-access", {
        skillId,
        agentIds,
      });
      const updated = response.data as SkillRecord;
      setSkills((prev) =>
        prev.map((item) => (item.id === updated.id ? updated : item)),
      );
      return updated;
    },
    [],
  );

  useEffect(() => {
    void loadSkills();
  }, [loadSkills]);

  return {
    skills,
    catalogSkills,
    loading,
    error,
    loadSkills,
    loadCatalogSkills,
    createSkill,
    deleteSkill,
    installCatalogSkill,
    toggleSkillEnabled,
    setSkillAccess,
  };
}
