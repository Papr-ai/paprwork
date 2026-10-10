/**
 * Cards for the My apps home: a collection (Papr-blue banner + up to six apps)
 * and a single app (cover or banner, overlapping icon, one status line).
 */
import { useEffect, useRef, useState, type DragEvent, type ReactNode } from "react";
import type { Artifact } from "../../stores/artifactsStore";
import type { ShareGlyph } from "../../utils/shareGlyph";
import { bannerShade, type DropZone } from "../../utils/appsHome";
import { isIdLikeTitle } from "../../utils/appsLibrary";
import { appCoverUrl } from "../../utils/appCover";
import { ShareAudienceIcon } from "./WebSyncPopover";
import { HomeIcon, type HomeIconName } from "./HomeIcon";

const SHOW = 6;

export const displayTitle = (a: Artifact) => (isIdLikeTitle(a.title) ? "Untitled app" : a.title);

/**
 * The app's logo inside the Papr glass droplet (same asset as AppCard's orb).
 * A full droplet render (PNG) already carries the sphere, so it shows as-is.
 * Apps with no icon get their first letter inside the droplet.
 */
export function AppGlyph({ app, size }: { app: Artifact; size: number }) {
  return <DropGlyph icon={app.icon} title={app.title} size={size} />;
}

/** Any logo (library app or catalog entry) inside the Papr glass droplet. */
export function DropGlyph({ icon: raw, title, size }: { icon?: string | null; title: string; size: number }) {
  const icon = raw?.trim() ?? "";
  const box = { width: size, height: size };
  if (/^(data:image\/|https?:\/\/)/.test(icon)) {
    return <img className="ah-gl ah-gl--img" src={icon} alt="" style={box} draggable={false} />;
  }
  if (icon.startsWith("<")) {
    return <span className="ah-gl ah-drop" style={box} dangerouslySetInnerHTML={{ __html: icon }} />;
  }
  if (icon && icon.length <= 4 && /\p{Extended_Pictographic}/u.test(icon)) {
    return (
      <span className="ah-gl ah-drop" style={{ ...box, fontSize: size * 0.42 }}>
        {icon}
      </span>
    );
  }
  const letter = isIdLikeTitle(title) ? "?" : (title.trim()[0] ?? "?").toUpperCase();
  return (
    <span className="ah-gl ah-drop ah-drop--letter" style={{ ...box, fontSize: size * 0.36 }}>
      {letter}
    </span>
  );
}

export function ShareMark({ share }: { share?: ShareGlyph }) {
  if (!share || share.audience === "private") return null;
  return (
    <span className="ah-share">
      <ShareAudienceIcon audience={share.audience} loginAccess={null} codeAccess={share.codeAccess} />
    </span>
  );
}

/** Title that turns into an input while renaming. */
export function AppName({
  app,
  renaming,
  onRename,
  onDone,
  className,
}: {
  app: Artifact;
  renaming: boolean;
  onRename: (title: string) => void;
  onDone: () => void;
  className: string;
}) {
  const [value, setValue] = useState(app.title);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!renaming) return;
    setValue(isIdLikeTitle(app.title) ? "" : app.title);
    requestAnimationFrame(() => ref.current?.select());
  }, [renaming, app.title]);
  if (!renaming) {
    return (
      <span className={className} title={displayTitle(app)}>
        {displayTitle(app)}
      </span>
    );
  }
  const commit = () => {
    const t = value.trim();
    if (t && t !== app.title) onRename(t);
    onDone();
  };
  return (
    <input
      ref={ref}
      className="ah-rename"
      value={value}
      aria-label="App name"
      onClick={(e) => e.stopPropagation()}
      onChange={(e) => setValue(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") commit();
        if (e.key === "Escape") onDone();
      }}
    />
  );
}

/** Drag wiring shared by every card. `zone` decides before / after / into from the pointer. */
export interface TileDnd {
  dragging: string | null;
  hover: { id: string; zone: DropZone } | null;
  onDragStart: (id: string, e: DragEvent, app?: Artifact) => void;
  onDragOver: (id: string, e: DragEvent, acceptsInto: boolean) => void;
  onDrop: (id: string, e: DragEvent) => void;
  onDragEnd: () => void;
}

function dndClass(id: string, dnd: TileDnd): string {
  const parts: string[] = [];
  if (dnd.dragging === id) parts.push("is-dragging");
  if (dnd.hover?.id === id) parts.push(`ah-drop-${dnd.hover.zone}`);
  return parts.join(" ");
}

export interface CollectionTileProps {
  id: string;
  name: string;
  icon: HomeIconName;
  apps: Artifact[];
  auto: boolean;
  dnd: TileDnd;
  attention: (a: Artifact) => boolean;
  shareById: Readonly<Record<string, ShareGlyph>>;
  renamingId: string | null;
  onOpenApp: (a: Artifact) => void;
  onOpenCollection: () => void;
  onRename: (a: Artifact, title: string) => void;
  onRenameDone: () => void;
  menuFor: (a: Artifact, folderId: string | null) => ReactNode;
}

export function CollectionTile(p: CollectionTileProps) {
  const shown = p.apps.length > SHOW ? p.apps.slice(0, SHOW - 1) : p.apps;
  const more = p.apps.length - shown.length;
  const big = p.apps.length > 3;
  const folderId = p.auto ? null : p.id;
  return (
    <div
      className={`ah-card ah-coll ${big ? "ah-coll--big" : ""} ${p.auto ? "ah-coll--auto" : ""} ${dndClass(p.id, p.dnd)}`}
      draggable={!p.auto}
      onDragStart={p.auto ? undefined : (e) => p.dnd.onDragStart(p.id, e)}
      onDragOver={p.auto ? undefined : (e) => p.dnd.onDragOver(p.id, e, true)}
      onDrop={p.auto ? undefined : (e) => p.dnd.onDrop(p.id, e)}
      onDragEnd={p.dnd.onDragEnd}
    >
      <div className={`ah-banner ah-pb-${bannerShade(p.id)}`}>
        <button type="button" className="ah-banner__head" onClick={p.onOpenCollection}>
          <HomeIcon name={p.icon} size={15} />
          <span className="ah-banner__name">{p.name}</span>
          <em>{p.apps.length}</em>
        </button>
      </div>
      <div className="ah-coll__grid">
        {shown.map((a) => (
          <div
            key={a.id}
            className={`ah-cell ${p.dnd.dragging === a.id ? "is-dragging" : ""}`}
            draggable
            onDragStart={(e) => {
              e.stopPropagation();
              p.dnd.onDragStart(a.id, e, a);
            }}
            onDragEnd={p.dnd.onDragEnd}
          >
            <button type="button" className="ah-cell__open" onClick={() => p.onOpenApp(a)} title={a.description || displayTitle(a)}>
              <span className="ah-cell__ic">
                <AppGlyph app={a} size={50} />
                {p.attention(a) ? <span className="ah-bad" title="Needs attention">!</span> : null}
                <ShareMark share={p.shareById[a.id]} />
              </span>
              <AppName
                app={a}
                className="ah-cell__t"
                renaming={p.renamingId === a.id}
                onRename={(t) => p.onRename(a, t)}
                onDone={p.onRenameDone}
              />
            </button>
            <span className="ah-cell__menu">{p.menuFor(a, folderId)}</span>
          </div>
        ))}
        {more > 0 ? (
          <div className="ah-cell">
            <button type="button" className="ah-cell__open" onClick={p.onOpenCollection}>
              <span className="ah-cell__ic">
                <span className="ah-gl ah-gl--more">+{more}</span>
              </span>
              <span className="ah-cell__t">See all</span>
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

export interface AppTileProps {
  app: Artifact;
  isNew: boolean;
  status: { text: string; bad: boolean } | null;
  meta: string;
  moveTo: string | null;
  share?: ShareGlyph;
  dnd: TileDnd;
  renaming: boolean;
  onOpen: () => void;
  onMove: () => void;
  onRename: (title: string) => void;
  onRenameDone: () => void;
  menu: ReactNode;
}

/** A loose app: cover (or banner) across the top, the icon overlapping it. */
export function AppTile(p: AppTileProps) {
  const [hasCover, setHasCover] = useState(true);
  const id = p.app.id;
  return (
    <div
      className={`ah-card ah-solo ${dndClass(id, p.dnd)}`}
      draggable
      onDragStart={(e) => p.dnd.onDragStart(id, e, p.app)}
      onDragOver={(e) => p.dnd.onDragOver(id, e, true)}
      onDrop={(e) => p.dnd.onDrop(id, e)}
      onDragEnd={p.dnd.onDragEnd}
    >
      <button type="button" className="ah-solo__open" onClick={p.onOpen} title={p.app.description || displayTitle(p.app)}>
        <span className={`ah-solo__art ah-pb-${bannerShade(id)}`}>
          {hasCover ? (
            <img
              className="ah-solo__cover"
              src={appCoverUrl(id, p.app.updatedAt)}
              alt=""
              loading="lazy"
              draggable={false}
              onError={() => setHasCover(false)}
            />
          ) : null}
          <span className="ah-solo__ic">
            <AppGlyph app={p.app} size={64} />
            {p.status?.bad ? <span className="ah-bad">!</span> : null}
          </span>
        </span>
        <AppName
          app={p.app}
          className="ah-solo__t"
          renaming={p.renaming}
          onRename={p.onRename}
          onDone={p.onRenameDone}
        />
      </button>
      <span className="ah-solo__meta">
        {p.isNew ? (
          <>
            <span className="ah-new">New</span>
            {p.moveTo ? (
              <button type="button" className="ah-move" onClick={p.onMove}>
                <HomeIcon name="layers" size={13} />
                Move to {p.moveTo}
              </button>
            ) : null}
          </>
        ) : (
          <>
            {p.status ? (
              <span className={p.status.bad ? "ah-st ah-st--bad" : "ah-st"} title={p.status.text}>
                {p.status.text}
              </span>
            ) : (
              <span className="ah-st ah-st--quiet">{p.meta}</span>
            )}
          </>
        )}
        <button type="button" className="ah-open" onClick={p.onOpen}>
          Open
        </button>
      </span>
      <span className="ah-solo__tr">
        <ShareMark share={p.share} />
        {p.menu}
      </span>
    </div>
  );
}
