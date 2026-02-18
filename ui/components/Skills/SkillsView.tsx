import { useEffect, useMemo, useState } from "react";
import { useSkills } from "../../hooks/useSkills";
import type { CatalogSkill } from "../../hooks/useSkills";
import "./SkillsView.css";

const CATEGORIES = [
  "all",
  "frontend",
  "backend",
  "design",
  "documents",
  "marketing",
  "productivity",
  "finance",
  "data",
  "integrations",
  "development",
  "search",
  "media",
  "business",
  "testing",
  "meta",
] as const;

type SkillCategory = (typeof CATEGORIES)[number];

function resolveCategory(skill: CatalogSkill): Exclude<SkillCategory, "all"> {
  // Use explicit category from catalog if available
  if (skill.category && CATEGORIES.includes(skill.category as SkillCategory)) {
    return skill.category as Exclude<SkillCategory, "all">;
  }
  // Fallback: infer from name + description
  const text = `${skill.name} ${skill.description}`.toLowerCase();
  if (text.includes("react") || text.includes("frontend") || text.includes("ui") || text.includes("native")) return "frontend";
  if (text.includes("design") || text.includes("ux")) return "design";
  if (text.includes("doc") || text.includes("pdf") || text.includes("pptx") || text.includes("xlsx") || text.includes("word")) return "documents";
  if (text.includes("test") || text.includes("qa")) return "testing";
  if (text.includes("marketing") || text.includes("seo") || text.includes("copy") || text.includes("content strat")) return "marketing";
  if (text.includes("finance") || text.includes("stock")) return "finance";
  if (text.includes("data") || text.includes("analysis") || text.includes("scraping")) return "data";
  if (text.includes("sql") || text.includes("server") || text.includes("backend") || text.includes("auth")) return "backend";
  if (text.includes("calendar") || text.includes("summarize") || text.includes("brainstorm")) return "productivity";
  if (text.includes("github") || text.includes("debug")) return "development";
  if (text.includes("slack") || text.includes("notion") || text.includes("email") || text.includes("crm") || text.includes("mcp")) return "integrations";
  if (text.includes("search") || text.includes("google")) return "search";
  if (text.includes("image") || text.includes("video")) return "media";
  if (text.includes("stripe") || text.includes("payment")) return "business";
  return "meta";
}

function categoryGradient(category: Exclude<SkillCategory, "all">): string {
  const map: Record<string, string> = {
    frontend: "linear-gradient(135deg, #667eea 0%, #764ba2 100%)",
    backend: "linear-gradient(135deg, #f093fb 0%, #f5576c 100%)",
    design: "linear-gradient(135deg, #4facfe 0%, #00f2fe 100%)",
    documents: "linear-gradient(135deg, #fa709a 0%, #fee140 100%)",
    testing: "linear-gradient(135deg, #30cfd0 0%, #330867 100%)",
    marketing: "linear-gradient(135deg, #ff9a9e 0%, #fad0c4 100%)",
    productivity: "linear-gradient(135deg, #a8edea 0%, #fed6e3 100%)",
    finance: "linear-gradient(135deg, #fbc2eb 0%, #a6c1ee 100%)",
    data: "linear-gradient(135deg, #84fab0 0%, #8fd3f4 100%)",
    integrations: "linear-gradient(135deg, #ffecd2 0%, #fcb69f 100%)",
    development: "linear-gradient(135deg, #a1c4fd 0%, #c2e9fb 100%)",
    search: "linear-gradient(135deg, #d4fc79 0%, #96e6a1 100%)",
    media: "linear-gradient(135deg, #f6d365 0%, #fda085 100%)",
    business: "linear-gradient(135deg, #fbc2eb 0%, #a18cd1 100%)",
    meta: "linear-gradient(135deg, #e0c3fc 0%, #8ec5fc 100%)",
  };
  return map[category] ?? map.meta;
}

function formatInstalls(count: number): string {
  if (count >= 1000000) return `${(count / 1000000).toFixed(1)}M`;
  if (count >= 1000) return `${(count / 1000).toFixed(1)}K`;
  return String(count);
}

export function SkillsView() {
  const {
    skills,
    catalogSkills,
    loading,
    error,
    deleteSkill,
    loadCatalogSkills,
    installCatalogSkill,
    toggleSkillEnabled,
  } = useSkills();
  const [currentCategory, setCurrentCategory] = useState<SkillCategory>("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [showInstalled, setShowInstalled] = useState(false);

  useEffect(() => {
    void loadCatalogSkills();
  }, [loadCatalogSkills]);

  const installedCatalogKeys = useMemo(
    () =>
      new Set(
        skills
          .filter((skill) => skill.source === "clawhub" || skill.source === "skills.sh")
          .map((skill) => `${skill.source}:${skill.externalId ?? skill.id}`),
      ),
    [skills],
  );

  // Compute which categories actually have skills for the filter bar
  const activeCategories = useMemo(() => {
    const cats = new Set<SkillCategory>(["all"]);
    for (const skill of catalogSkills) {
      cats.add(resolveCategory(skill));
    }
    return cats;
  }, [catalogSkills]);

  const filteredCatalog = useMemo(() => {
    return catalogSkills
      .filter((skill) => {
        const category = resolveCategory(skill);
        if (currentCategory !== "all" && category !== currentCategory) return false;
        if (!searchQuery.trim()) return true;
        const haystack = `${skill.name} ${skill.description} ${(skill.tags ?? []).join(" ")}`.toLowerCase();
        return haystack.includes(searchQuery.toLowerCase());
      })
      .sort((a, b) => (b.installs ?? 0) - (a.installs ?? 0)); // Sort by popularity
  }, [catalogSkills, currentCategory, searchQuery]);

  return (
    <div className="skills-page">
      <div className="skills-header">
        <div className="skills-header-main">
          <h1>Skills Marketplace</h1>
          <p className="skills-subtitle">
            Browse and install specialized skills for your agents
            {catalogSkills.length > 0 && (
              <span className="skills-count">{catalogSkills.length}+ Available</span>
            )}
          </p>
        </div>
        <div className="skills-header-actions">
          <div className="skills-search">
            <input
              id="skills-search-input"
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              placeholder="Search skills..."
            />
          </div>
          <button className="btn-secondary" id="view-installed-btn" onClick={() => setShowInstalled(true)}>
            Installed ({skills.length})
          </button>
        </div>
      </div>

      {!showInstalled && (
        <>
          <div className="skills-categories">
            {CATEGORIES.filter((cat) => activeCategories.has(cat)).map((category) => (
              <button
                key={category}
                className={currentCategory === category ? "category-btn active" : "category-btn"}
                onClick={() => setCurrentCategory(category)}
              >
                {category}
              </button>
            ))}
          </div>

          {loading && (
            <div className="skills-loading">
              <div className="spinner" />
              <p>Loading skills...</p>
            </div>
          )}

          {!loading && (
            <div className="skills-grid">
              {filteredCatalog.map((skill) => {
                const category = resolveCategory(skill);
                const key = `${skill.source}:${skill.id}`;
                const installed = installedCatalogKeys.has(key);
                return (
                  <div className="skill-card-compact" key={key}>
                    <div className="skill-card-icon-compact" style={{ background: categoryGradient(category) }}>
                      {category.slice(0, 1).toUpperCase()}
                    </div>
                    <div className="skill-card-content-compact">
                      <h3 className="skill-card-name-compact">{skill.name}</h3>
                      <p className="skill-card-description-compact">{skill.description}</p>
                    </div>
                    <button
                      className={installed ? "skill-action-btn installed" : "skill-action-btn"}
                      disabled={installed}
                      onClick={() => void installCatalogSkill(skill.source, skill.id)}
                    >
                      {installed ? "Added" : "Add"}
                    </button>
                  </div>
                );
              })}
              {!loading && filteredCatalog.length === 0 && (
                <div className="skills-empty">
                  <h3>No Matching Skills</h3>
                  <p>Try adjusting category or search.</p>
                </div>
              )}
            </div>
          )}
        </>
      )}

      {showInstalled && (
        <div className="installed-skills-view">
          <div className="installed-header">
            <button className="back-btn" id="back-to-marketplace" onClick={() => setShowInstalled(false)}>
              Back to Marketplace
            </button>
            <h2>Installed Skills ({skills.length})</h2>
          </div>
          <div className="installed-skills-grid" id="installed-skills-grid">
            {skills.map((skill) => (
              <div className="skill-card-compact" key={skill.id}>
                <div className="skill-card-icon-compact" style={{ background: "linear-gradient(135deg, #667eea 0%, #764ba2 100%)" }}>
                  S
                </div>
                <div className="skill-card-content-compact">
                  <h3 className="skill-card-name-compact">{skill.name}</h3>
                  <p className="skill-card-description-compact">{skill.description}</p>
                </div>
                <button
                  className="skill-action-btn remove"
                  onClick={() => void deleteSkill(skill.id)}
                >
                  Remove
                </button>
              </div>
            ))}
            {skills.length === 0 && (
              <div className="skills-empty">
                <h3>No skills installed</h3>
                <p>Install skills from the marketplace to enhance your agent</p>
              </div>
            )}
          </div>
        </div>
      )}

      {error && <div className="skills-empty">{error}</div>}
    </div>
  );
}
