import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { useChat } from "../../hooks/useChat";
import { useSkills } from "../../hooks/useSkills";
import type { CatalogSkill, SkillRecord } from "../../hooks/useSkills";
import { useTabs } from "../../hooks/useTabs";
import { startSkillChat } from "../../utils/startSkillChat";
import "./SkillsView.css";

const FINE_CATEGORIES = [
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

type FineCategory = (typeof FINE_CATEGORIES)[number];

const TOP_LEVEL_CATEGORIES = [
  "all",
  "sales-marketing",
  "business",
  "data",
  "design",
  "other",
] as const;

type TopLevelCategory = (typeof TOP_LEVEL_CATEGORIES)[number];

const TOP_LEVEL_LABELS: Record<TopLevelCategory, string> = {
  all: "All Skills",
  "sales-marketing": "Sales & Marketing",
  business: "Business",
  data: "Data",
  design: "Design",
  other: "Other",
};

const OTHER_SUBCATEGORIES = [
  "all-other",
  "backend",
  "documents",
  "integrations",
  "development",
  "search",
  "media",
  "testing",
  "meta",
] as const;

type OtherSubcategory = (typeof OTHER_SUBCATEGORIES)[number];

const OTHER_SUB_LABELS: Record<Exclude<OtherSubcategory, "all-other">, string> =
  {
    backend: "Backend",
    documents: "Documents",
    integrations: "Integrations",
    development: "Development",
    search: "Search",
    media: "Media",
    testing: "Testing",
    meta: "Meta",
  };

interface CategoryInput {
  name: string;
  description: string;
  category?: string;
  source?: CatalogSkill["source"];
}

function resolveFineCategory(input: CategoryInput): FineCategory {
  if (input.category && FINE_CATEGORIES.includes(input.category as FineCategory)) {
    return input.category as FineCategory;
  }
  const text = `${input.name} ${input.description}`.toLowerCase();
  if (
    text.includes("react") ||
    text.includes("frontend") ||
    text.includes("ui") ||
    text.includes("native")
  )
    return "frontend";
  if (text.includes("design") || text.includes("ux")) return "design";
  if (
    text.includes("doc") ||
    text.includes("pdf") ||
    text.includes("pptx") ||
    text.includes("xlsx") ||
    text.includes("word")
  )
    return "documents";
  if (text.includes("test") || text.includes("qa")) return "testing";
  if (
    text.includes("marketing") ||
    text.includes("seo") ||
    text.includes("copy") ||
    text.includes("content strat") ||
    text.includes("outreach") ||
    text.includes("gtm") ||
    text.includes("sales") ||
    text.includes("prospect") ||
    text.includes("abm")
  )
    return "marketing";
  if (text.includes("finance") || text.includes("stock")) return "finance";
  if (
    text.includes("data") ||
    text.includes("analysis") ||
    text.includes("scraping")
  )
    return "data";
  if (
    text.includes("sql") ||
    text.includes("server") ||
    text.includes("backend") ||
    text.includes("auth")
  )
    return "backend";
  if (
    text.includes("calendar") ||
    text.includes("summarize") ||
    text.includes("brainstorm")
  )
    return "productivity";
  if (text.includes("github") || text.includes("debug")) return "development";
  if (
    text.includes("slack") ||
    text.includes("notion") ||
    text.includes("email") ||
    text.includes("crm") ||
    text.includes("mcp")
  )
    return "integrations";
  if (text.includes("search") || text.includes("google")) return "search";
  if (text.includes("image") || text.includes("video")) return "media";
  return "meta";
}

function resolveTopLevelCategory(input: CategoryInput): Exclude<TopLevelCategory, "all"> {
  const fine = resolveFineCategory(input);
  if (
    input.source === "gtmskills.com" ||
    input.source === "gtm-skills.com"
  ) {
    if (fine === "data") return "data";
    if (fine === "design" || fine === "frontend") return "design";
    return "sales-marketing";
  }
  switch (fine) {
    case "marketing":
      return "sales-marketing";
    case "frontend":
    case "design":
      return "design";
    case "data":
      return "data";
    case "business":
    case "finance":
    case "productivity":
      return "business";
    default:
      return "other";
  }
}

function matchesTopLevelFilter(
  input: CategoryInput,
  topLevel: TopLevelCategory,
  otherSub: OtherSubcategory,
): boolean {
  if (topLevel === "all") {
    return true;
  }
  const fine = resolveFineCategory(input);
  const skillTopLevel = resolveTopLevelCategory(input);
  if (skillTopLevel !== topLevel) {
    return false;
  }
  if (topLevel !== "other" || otherSub === "all-other") {
    return true;
  }
  return fine === otherSub;
}

function resolveInstalledFineCategory(
  skill: SkillRecord,
  catalogSkills: CatalogSkill[],
): FineCategory {
  if (
    skill.source === "clawhub" ||
    skill.source === "skills.sh" ||
    skill.source === "gtmskills.com" ||
    skill.source === "gtm-skills.com"
  ) {
    const externalId = skill.externalId ?? skill.id;
    const catalogMatch = catalogSkills.find(
      (item) => item.source === skill.source && item.id === externalId,
    );
    if (catalogMatch) {
      return resolveFineCategory(catalogMatch);
    }
  }
  return resolveFineCategory(skill);
}

function installedCategoryInput(
  skill: SkillRecord,
  catalogSkills: CatalogSkill[],
): CategoryInput {
  if (
    skill.source === "clawhub" ||
    skill.source === "skills.sh" ||
    skill.source === "gtmskills.com" ||
    skill.source === "gtm-skills.com"
  ) {
    const externalId = skill.externalId ?? skill.id;
    const catalogMatch = catalogSkills.find(
      (item) => item.source === skill.source && item.id === externalId,
    );
    if (catalogMatch) {
      return catalogMatch;
    }
  }
  return skill;
}

function catalogKey(source: CatalogSkill["source"], id: string): string {
  return `${source}:${id}`;
}

function matchesSearch(
  name: string,
  description: string,
  tags: string[] | undefined,
  query: string,
): boolean {
  if (!query.trim()) return true;
  const haystack =
    `${name} ${description} ${(tags ?? []).join(" ")}`.toLowerCase();
  return haystack.includes(query.toLowerCase());
}

function categoryGradient(category: FineCategory): string {
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

function SkillCardCompact({
  name,
  description,
  category,
  action,
  badge,
  variant = "default",
}: {
  name: string;
  description: string;
  category: FineCategory;
  action: ReactNode;
  badge?: string;
  variant?: "default" | "featured";
}) {
  return (
    <div
      className={
        variant === "featured"
          ? "skill-card-compact skill-card-compact--featured"
          : "skill-card-compact"
      }
    >
      <div
        className="skill-card-icon-compact"
        style={{ background: categoryGradient(category) }}
      >
        {category.slice(0, 1).toUpperCase()}
      </div>
      <div className="skill-card-content-compact">
        <div className="skill-card-title-row">
          <h3 className="skill-card-name-compact">{name}</h3>
          {badge ? <span className="skill-card-inline-badge">{badge}</span> : null}
        </div>
        <p className="skill-card-description-compact">{description}</p>
      </div>
      {action}
    </div>
  );
}

function InstalledSkillActions({
  skill,
  onUse,
  onRemove,
}: {
  skill: SkillRecord;
  onUse: (skill: SkillRecord) => void;
  onRemove?: (skillId: string) => void;
}) {
  const isPreloaded = skill.source === "preloaded";
  return (
    <div className="skill-card-actions">
      {!isPreloaded && onRemove ? (
        <button
          type="button"
          className="skill-action-btn remove"
          onClick={() => onRemove(skill.id)}
        >
          Remove
        </button>
      ) : null}
      <button
        type="button"
        className="skill-action-btn"
        onClick={() => onUse(skill)}
      >
        Use
      </button>
    </div>
  );
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
  } = useSkills();
  const { createChat } = useChat();
  const { createTab, switchToTab } = useTabs();
  const [currentCategory, setCurrentCategory] =
    useState<TopLevelCategory>("all");
  const [otherSubcategory, setOtherSubcategory] =
    useState<OtherSubcategory>("all-other");
  const [searchQuery, setSearchQuery] = useState("");
  const [showInstalled, setShowInstalled] = useState(false);
  const [installingKey, setInstallingKey] = useState<string | null>(null);

  useEffect(() => {
    void loadCatalogSkills();
  }, [loadCatalogSkills]);

  const installedCatalogKeys = useMemo(
    () =>
      new Set(
        skills
          .filter(
            (skill) =>
              skill.source === "clawhub" ||
              skill.source === "skills.sh" ||
              skill.source === "gtmskills.com" ||
              skill.source === "gtm-skills.com",
          )
          .map((skill) => `${skill.source}:${skill.externalId ?? skill.id}`),
      ),
    [skills],
  );

  const activeTopLevelCategories = useMemo(() => {
    const cats = new Set<TopLevelCategory>(["all"]);
    for (const skill of catalogSkills) {
      cats.add(resolveTopLevelCategory(skill));
    }
    for (const skill of skills) {
      cats.add(
        resolveTopLevelCategory(installedCategoryInput(skill, catalogSkills)),
      );
    }
    return cats;
  }, [catalogSkills, skills]);

  const activeOtherSubcategories = useMemo(() => {
    const subs = new Set<OtherSubcategory>(["all-other"]);
    const addIfOtherFine = (input: CategoryInput) => {
      if (resolveTopLevelCategory(input) !== "other") return;
      const fine = resolveFineCategory(input);
      if (fine in OTHER_SUB_LABELS) {
        subs.add(fine as Exclude<OtherSubcategory, "all-other">);
      }
    };
    for (const skill of catalogSkills) {
      addIfOtherFine(skill);
    }
    for (const skill of skills) {
      addIfOtherFine(installedCategoryInput(skill, catalogSkills));
    }
    return subs;
  }, [catalogSkills, skills]);

  const topLevelCounts = useMemo(() => {
    const counts = new Map<TopLevelCategory, number>();
    counts.set("all", catalogSkills.length);
    for (const skill of catalogSkills) {
      const topLevel = resolveTopLevelCategory(skill);
      counts.set(topLevel, (counts.get(topLevel) ?? 0) + 1);
    }
    return counts;
  }, [catalogSkills]);

  const otherSubCounts = useMemo(() => {
    const counts = new Map<OtherSubcategory, number>();
    counts.set("all-other", topLevelCounts.get("other") ?? 0);
    for (const skill of catalogSkills) {
      if (resolveTopLevelCategory(skill) !== "other") continue;
      const fine = resolveFineCategory(skill);
      if (fine in OTHER_SUB_LABELS) {
        counts.set(
          fine as Exclude<OtherSubcategory, "all-other">,
          (counts.get(fine as Exclude<OtherSubcategory, "all-other">) ?? 0) + 1,
        );
      }
    }
    return counts;
  }, [catalogSkills, topLevelCounts]);

  const installedTopLevelCounts = useMemo(() => {
    const counts = new Map<TopLevelCategory, number>();
    counts.set("all", skills.length);
    for (const skill of skills) {
      const topLevel = resolveTopLevelCategory(
        installedCategoryInput(skill, catalogSkills),
      );
      counts.set(topLevel, (counts.get(topLevel) ?? 0) + 1);
    }
    return counts;
  }, [skills, catalogSkills]);

  const featuredInstalled = useMemo(() => {
    return skills
      .filter((skill) => {
        const input = installedCategoryInput(skill, catalogSkills);
        if (
          !matchesTopLevelFilter(input, currentCategory, otherSubcategory)
        ) {
          return false;
        }
        return matchesSearch(skill.name, skill.description, undefined, searchQuery);
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [skills, catalogSkills, currentCategory, otherSubcategory, searchQuery]);

  const marketplaceCatalog = useMemo(() => {
    return catalogSkills
      .filter((skill) => {
        if (
          !matchesTopLevelFilter(skill, currentCategory, otherSubcategory)
        ) {
          return false;
        }
        if (
          !matchesSearch(
            skill.name,
            skill.description,
            skill.tags,
            searchQuery,
          )
        ) {
          return false;
        }
        return !installedCatalogKeys.has(catalogKey(skill.source, skill.id));
      })
      .sort((a, b) => (b.installs ?? 0) - (a.installs ?? 0));
  }, [
    catalogSkills,
    currentCategory,
    otherSubcategory,
    searchQuery,
    installedCatalogKeys,
  ]);

  const handleUseSkill = useCallback(
    (skill: SkillRecord) => {
      void startSkillChat(
        createChat,
        createTab,
        switchToTab,
        skill.id,
        skill.name,
      );
    },
    [createChat, createTab, switchToTab],
  );

  const selectTopLevelCategory = (category: TopLevelCategory) => {
    setCurrentCategory(category);
    if (category !== "other") {
      setOtherSubcategory("all-other");
    }
  };

  const handleInstall = (source: CatalogSkill["source"], id: string) => {
    const key = catalogKey(source, id);
    void (async () => {
      setInstallingKey(key);
      try {
        await installCatalogSkill(source, id);
      } catch {
        // surfaced via useSkills error state
      } finally {
        setInstallingKey(null);
      }
    })();
  };

  return (
    <div className="skills-page">
      <div className="skills-header">
        <div className="skills-header-main">
          <h1>Skills Marketplace</h1>
          <p className="skills-subtitle">
            Browse and install specialized skills for your agents
            {catalogSkills.length > 0 && (
              <span className="skills-count">
                {catalogSkills.length}+ Available
              </span>
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
          <button
            className="btn-secondary"
            id="view-installed-btn"
            onClick={() => setShowInstalled(true)}
          >
            Installed ({skills.length})
          </button>
        </div>
      </div>

      {error && (
        <p className="skills-view__status skills-view__status--error">{error}</p>
      )}

      {!showInstalled && (
        <div className="skills-layout">
          <aside className="skills-sidebar" aria-label="Skill categories">
            <p className="skills-sidebar__label">Categories</p>
            <nav className="skills-sidebar__nav">
              {TOP_LEVEL_CATEGORIES.filter((cat) =>
                activeTopLevelCategories.has(cat),
              ).map((category) => {
                const installedCount =
                  installedTopLevelCounts.get(category) ?? 0;
                return (
                  <button
                    key={category}
                    type="button"
                    className={
                      currentCategory === category
                        ? "skills-sidebar__btn skills-sidebar__btn--active"
                        : "skills-sidebar__btn"
                    }
                    onClick={() => selectTopLevelCategory(category)}
                  >
                    <span className="skills-sidebar__btn-label">
                      {TOP_LEVEL_LABELS[category]}
                    </span>
                    <span className="skills-sidebar__btn-meta">
                      {installedCount > 0 && (
                        <span className="skills-sidebar__installed-dot">
                          {installedCount}
                        </span>
                      )}
                      <span className="skills-sidebar__count">
                        {topLevelCounts.get(category) ?? 0}
                      </span>
                    </span>
                  </button>
                );
              })}
            </nav>

            {currentCategory === "other" && (
              <div className="skills-sidebar__subnav">
                <p className="skills-sidebar__subnav-label">Browse within Other</p>
                {OTHER_SUBCATEGORIES.filter((sub) =>
                  activeOtherSubcategories.has(sub),
                ).map((sub) => (
                  <button
                    key={sub}
                    type="button"
                    className={
                      otherSubcategory === sub
                        ? "skills-sidebar__subbtn skills-sidebar__subbtn--active"
                        : "skills-sidebar__subbtn"
                    }
                    onClick={() => setOtherSubcategory(sub)}
                  >
                    <span>
                      {sub === "all-other"
                        ? "All other"
                        : OTHER_SUB_LABELS[sub]}
                    </span>
                    <span className="skills-sidebar__count">
                      {otherSubCounts.get(sub) ?? 0}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </aside>

          <div className="skills-main">
            {loading && (
              <div className="skills-loading">
                <div className="spinner" />
                <p>Loading skills...</p>
              </div>
            )}

            {!loading && (
              <>
                {featuredInstalled.length > 0 && (
                  <section className="skills-featured" aria-label="Installed skills">
                    <div className="skills-featured__header">
                      <div>
                        <h2 className="skills-featured__title">Your installed skills</h2>
                        <p className="skills-featured__subtitle">
                          {currentCategory === "all"
                            ? "Ready for your agents in this view"
                            : currentCategory === "other" &&
                                otherSubcategory !== "all-other"
                              ? `Installed in ${OTHER_SUB_LABELS[otherSubcategory]}`
                              : `Installed in ${TOP_LEVEL_LABELS[currentCategory].toLowerCase()}`}
                        </p>
                      </div>
                      <span className="skills-featured__count">
                        {featuredInstalled.length}
                      </span>
                    </div>
                    <div className="skills-featured__grid">
                      {featuredInstalled.map((skill) => {
                        const category = resolveInstalledFineCategory(
                          skill,
                          catalogSkills,
                        );
                        const isPreloaded = skill.source === "preloaded";
                        return (
                          <SkillCardCompact
                            key={skill.id}
                            name={skill.name}
                            description={skill.description}
                            category={category}
                            badge={isPreloaded ? "Built-in" : "Installed"}
                            variant="featured"
                            action={
                              <InstalledSkillActions
                                skill={skill}
                                onUse={handleUseSkill}
                                onRemove={
                                  isPreloaded ? undefined : deleteSkill
                                }
                              />
                            }
                          />
                        );
                      })}
                    </div>
                  </section>
                )}

                <section className="skills-browse" aria-label="Marketplace skills">
                  {featuredInstalled.length > 0 && (
                    <div className="skills-section-heading">
                      <h2>Browse marketplace</h2>
                      <p>
                        {marketplaceCatalog.length} more skill
                        {marketplaceCatalog.length === 1 ? "" : "s"} to explore
                      </p>
                    </div>
                  )}

                  <div className="skills-grid">
                    {marketplaceCatalog.map((skill) => {
                      const category = resolveFineCategory(skill);
                      const key = catalogKey(skill.source, skill.id);
                      const isInstalling = installingKey === key;
                      return (
                        <SkillCardCompact
                          key={key}
                          name={skill.name}
                          description={skill.description}
                          category={category}
                          action={
                            <button
                              type="button"
                              className="skill-action-btn"
                              disabled={isInstalling}
                              onClick={() => handleInstall(skill.source, skill.id)}
                            >
                              {isInstalling ? "Adding..." : "Add"}
                            </button>
                          }
                        />
                      );
                    })}
                  </div>

                  {marketplaceCatalog.length === 0 &&
                    featuredInstalled.length === 0 && (
                      <div className="skills-empty">
                        <h3>No matching skills</h3>
                        <p>Try another category or search term.</p>
                      </div>
                    )}

                  {marketplaceCatalog.length === 0 &&
                    featuredInstalled.length > 0 && (
                      <div className="skills-empty skills-empty--inline">
                        <p>No additional marketplace skills match this filter.</p>
                      </div>
                    )}
                </section>
              </>
            )}
          </div>
        </div>
      )}

      {showInstalled && (
        <div className="installed-skills-view">
          <div className="installed-header">
            <button
              className="back-btn"
              id="back-to-marketplace"
              onClick={() => setShowInstalled(false)}
            >
              Back to Marketplace
            </button>
            <h2>Installed Skills ({skills.length})</h2>
          </div>
          <div className="installed-skills-grid" id="installed-skills-grid">
            {skills.map((skill) => {
              const category = resolveInstalledFineCategory(skill, catalogSkills);
              const isPreloaded = skill.source === "preloaded";
              return (
                <SkillCardCompact
                  key={skill.id}
                  name={skill.name}
                  description={skill.description}
                  category={category}
                  badge={isPreloaded ? "Built-in" : undefined}
                  action={
                    <InstalledSkillActions
                      skill={skill}
                      onUse={handleUseSkill}
                      onRemove={isPreloaded ? undefined : deleteSkill}
                    />
                  }
                />
              );
            })}
            {skills.length === 0 && (
              <div className="skills-empty">
                <h3>No skills installed</h3>
                <p>Install skills from the marketplace to enhance your agent</p>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
