/**
 * Gallery for generate_media results — rendered outside the Working card.
 * Supports carousel navigation when multiple assets were created in one turn.
 */

import React, { useEffect, useMemo, useRef, useState } from "react";
import type { GeneratedMediaGalleryItem } from "../../utils/generatedMediaPreview.js";
import {
  formatGeneratedMediaSize,
  resolveGeneratedMediaPreviewFallbackSrc,
  resolveGeneratedMediaPreviewSrc,
} from "../../utils/generatedMediaPreview.js";
import "./GeneratedMediaGallery.css";

interface GeneratedMediaGalleryProps {
  items: GeneratedMediaGalleryItem[];
  isStreaming?: boolean;
}

function truncatePrompt(prompt: string, maxLen = 140): string {
  const trimmed = prompt.trim();
  if (trimmed.length <= maxLen) return trimmed;
  return `${trimmed.slice(0, maxLen - 1)}…`;
}

const GALLERY_LOGO_GRADIENT_ID = "papr-gradient-generated-media-gallery";

function GalleryPaprIcon() {
  return (
    <span className="generated-media-gallery__icon" aria-hidden="true">
      <svg
        width="13"
        height="13"
        viewBox="0 0 105 124"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        className="generated-media-gallery__icon-svg"
      >
        <path
          d="M27.9998 101.5C-11.5 158 6.99988 51 43.4008 60.5002C99.2884 75.0861 115.18 20.7781 83.6804 8.27816C40.2693 -8.94844 51.9998 65 27.9998 101.5Z"
          stroke={`url(#${GALLERY_LOGO_GRADIENT_ID})`}
          strokeWidth="10"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <defs>
          <linearGradient
            id={GALLERY_LOGO_GRADIENT_ID}
            x1="17.2207"
            y1="89.4214"
            x2="68.8959"
            y2="35.8394"
            gradientUnits="userSpaceOnUse"
          >
            <stop stopColor="#0060E0" />
            <stop offset="0.6" stopColor="#00ACFA" />
            <stop offset="1" stopColor="#0BCDFF" />
          </linearGradient>
        </defs>
      </svg>
    </span>
  );
}

const MediaSlide: React.FC<{
  item: GeneratedMediaGalleryItem;
  src: string | undefined;
  failed: boolean;
  isActive: boolean;
  onPreviewError: (item: GeneratedMediaGalleryItem) => void;
}> = ({ item, src, failed, isActive, onPreviewError }) => {
  if (!isActive) return null;

  if (src && item.kind === "image") {
    return (
      <img
        className="generated-media-gallery__media generated-media-gallery__media--image"
        src={src}
        alt={item.fileName ?? "Generated image"}
        onError={() => onPreviewError(item)}
      />
    );
  }

  if (src && item.kind === "video") {
    return (
      <video
        className="generated-media-gallery__media generated-media-gallery__media--video"
        src={src}
        controls
        playsInline
        preload="metadata"
        onError={() => onPreviewError(item)}
      />
    );
  }

  if (failed) {
    return (
      <div className="generated-media-gallery__fallback">
        Preview unavailable
        {item.localPath ? (
          <>
            {" "}
            — saved to{" "}
            <code className="generated-media-gallery__path">{item.localPath}</code>
          </>
        ) : null}
      </div>
    );
  }

  return <div className="generated-media-gallery__loading">Loading preview…</div>;
};

export const GeneratedMediaGallery: React.FC<GeneratedMediaGalleryProps> = ({
  items,
  isStreaming = false,
}) => {
  const [index, setIndex] = useState(0);
  const [srcById, setSrcById] = useState<Record<string, string>>({});
  const [failedIds, setFailedIds] = useState<Set<string>>(() => new Set());
  const fallbackAttemptedRef = useRef<Set<string>>(new Set());
  const previousCountRef = useRef(items.length);

  const safeIndex = items.length === 0 ? 0 : Math.min(index, items.length - 1);
  const current = items[safeIndex];

  const counts = useMemo(() => {
    const images = items.filter((item) => item.kind === "image").length;
    const videos = items.filter((item) => item.kind === "video").length;
    return { images, videos };
  }, [items]);

  useEffect(() => {
    if (items.length === 0) {
      setIndex(0);
      previousCountRef.current = 0;
      return;
    }

    if (items.length > previousCountRef.current && isStreaming) {
      setIndex(items.length - 1);
    } else if (index >= items.length) {
      setIndex(items.length - 1);
    }

    previousCountRef.current = items.length;
  }, [items.length, isStreaming, index]);

  useEffect(() => {
    fallbackAttemptedRef.current = new Set();
    let cancelled = false;

    for (const item of items) {
      void resolveGeneratedMediaPreviewSrc(item)
        .then((src) => {
          if (cancelled) return;
          if (src) {
            setSrcById((prev) =>
              prev[item.id] ? prev : { ...prev, [item.id]: src },
            );
            return;
          }
          setFailedIds((prev) => {
            if (prev.has(item.id)) return prev;
            const next = new Set(prev);
            next.add(item.id);
            return next;
          });
        })
        .catch(() => {
          if (cancelled) return;
          setFailedIds((prev) => {
            if (prev.has(item.id)) return prev;
            const next = new Set(prev);
            next.add(item.id);
            return next;
          });
        });
    }

    return () => {
      cancelled = true;
    };
  }, [items]);

  const handlePreviewError = (item: GeneratedMediaGalleryItem) => {
    if (fallbackAttemptedRef.current.has(item.id)) {
      setFailedIds((prev) => {
        if (prev.has(item.id)) return prev;
        const next = new Set(prev);
        next.add(item.id);
        return next;
      });
      return;
    }

    fallbackAttemptedRef.current.add(item.id);
    void resolveGeneratedMediaPreviewFallbackSrc(item)
      .then((src) => {
        if (src) {
          setSrcById((prev) => ({ ...prev, [item.id]: src }));
          setFailedIds((prev) => {
            if (!prev.has(item.id)) return prev;
            const next = new Set(prev);
            next.delete(item.id);
            return next;
          });
          return;
        }
        setFailedIds((prev) => {
          if (prev.has(item.id)) return prev;
          const next = new Set(prev);
          next.add(item.id);
          return next;
        });
      })
      .catch(() => {
        setFailedIds((prev) => {
          if (prev.has(item.id)) return prev;
          const next = new Set(prev);
          next.add(item.id);
          return next;
        });
      });
  };

  if (items.length === 0 || !current) {
    return null;
  }

  const hasMultiple = items.length > 1;
  const metaParts = [
    current.fileName,
    formatGeneratedMediaSize(current.sizeBytes),
    current.modelId,
  ].filter(Boolean);

  const summaryParts: string[] = [];
  if (counts.images > 0) {
    summaryParts.push(`${counts.images} image${counts.images === 1 ? "" : "s"}`);
  }
  if (counts.videos > 0) {
    summaryParts.push(`${counts.videos} video${counts.videos === 1 ? "" : "s"}`);
  }
  const summary = summaryParts.join(", ");

  return (
    <div className="generated-media-gallery" data-testid="generated-media-gallery">
      <div className="generated-media-gallery__header">
        <div className="generated-media-gallery__header-left">
          <GalleryPaprIcon />
          <span className="generated-media-gallery__title">Generated media</span>
          {summary ? (
            <span className="generated-media-gallery__summary">{summary}</span>
          ) : null}
        </div>
        {hasMultiple ? (
          <span className="generated-media-gallery__counter">
            {safeIndex + 1} / {items.length}
          </span>
        ) : null}
      </div>

      <div
        className={`generated-media-gallery__stage${
          hasMultiple ? "" : " generated-media-gallery__stage--single"
        }`}
      >
        {hasMultiple ? (
          <button
            type="button"
            className="generated-media-gallery__nav generated-media-gallery__nav--prev"
            aria-label="Previous media"
            disabled={safeIndex <= 0}
            onClick={() => setIndex((value) => Math.max(0, value - 1))}
          >
            ‹
          </button>
        ) : null}

        <div className="generated-media-gallery__viewport">
          <MediaSlide
            item={current}
            src={srcById[current.id]}
            failed={failedIds.has(current.id)}
            isActive
            onPreviewError={handlePreviewError}
          />
        </div>

        {hasMultiple ? (
          <button
            type="button"
            className="generated-media-gallery__nav generated-media-gallery__nav--next"
            aria-label="Next media"
            disabled={safeIndex >= items.length - 1}
            onClick={() =>
              setIndex((value) => Math.min(items.length - 1, value + 1))
            }
          >
            ›
          </button>
        ) : null}
      </div>

      {hasMultiple ? (
        <div className="generated-media-gallery__dots" role="tablist">
          {items.map((item, dotIndex) => (
            <button
              key={item.id}
              type="button"
              role="tab"
              aria-selected={dotIndex === safeIndex}
              aria-label={`Show ${item.kind} ${dotIndex + 1}`}
              className={`generated-media-gallery__dot${
                dotIndex === safeIndex ? " generated-media-gallery__dot--active" : ""
              }${item.kind === "video" ? " generated-media-gallery__dot--video" : ""}`}
              onClick={() => setIndex(dotIndex)}
            />
          ))}
        </div>
      ) : null}

      {(current.prompt || metaParts.length > 0) && (
        <div className="generated-media-gallery__meta">
          {current.prompt ? (
            <p className="generated-media-gallery__prompt">
              {truncatePrompt(current.prompt)}
            </p>
          ) : null}
          {metaParts.length > 0 ? (
            <p className="generated-media-gallery__details">{metaParts.join(" · ")}</p>
          ) : null}
        </div>
      )}
    </div>
  );
};
