/**
 * SharePeoplePicker — choose which workspace people can open this app.
 *
 * One job: turn names into an allowlist of Parse _User.objectId values.
 * Type to filter, Enter to add, Backspace on an empty field removes the last
 * person. Handles like @amir-kabbara exist for typing and recognition only —
 * the value committed upstream is always the user id.
 */

import React, { useMemo, useRef, useState } from "react";
import { UserAvatar } from "../common/UserAvatar";
import {
  buildUniqueMentionHandles,
  matchesMentionQuery,
} from "../../utils/mentionHandle";
import "./SharePeoplePicker.css";

export interface SharePeopleMember {
  userId: string;
  displayName: string;
  email: string;
  imageUrl?: string;
}

interface SharePeoplePickerProps {
  members: SharePeopleMember[];
  value: string[];
  onChange: (userIds: string[]) => void;
  loading?: boolean;
  disabled?: boolean;
  /** Publisher — always retains access, so shown as a fixed chip. */
  currentUserId?: string | null;
}

export function SharePeoplePicker({
  members,
  value,
  onChange,
  loading = false,
  disabled = false,
  currentUserId = null,
}: SharePeoplePickerProps) {
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const handles = useMemo(() => buildUniqueMentionHandles(members), [members]);
  const byId = useMemo(
    () => new Map(members.map((m) => [m.userId, m])),
    [members],
  );

  // The publisher is enforced as always-allowed on the server, so listing them
  // as selectable would imply they could be removed.
  const selectable = useMemo(
    () => members.filter((m) => m.userId !== currentUserId),
    [members, currentUserId],
  );

  const selected = useMemo(
    () => value.map((id) => byId.get(id)).filter(Boolean) as SharePeopleMember[],
    [value, byId],
  );

  const suggestions = useMemo(() => {
    const chosen = new Set(value);
    return selectable.filter(
      (m) =>
        !chosen.has(m.userId) &&
        matchesMentionQuery(
          { userId: m.userId, displayName: m.displayName, email: m.email },
          handles.get(m.userId) ?? "",
          query,
        ),
    );
  }, [selectable, value, handles, query]);

  const add = (userId: string) => {
    if (!value.includes(userId)) {
      onChange([...value, userId]);
    }
    setQuery("");
    setActiveIndex(0);
    inputRef.current?.focus();
  };

  const remove = (userId: string) => {
    onChange(value.filter((id) => id !== userId));
    inputRef.current?.focus();
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Backspace" && query === "" && value.length > 0) {
      remove(value[value.length - 1]!);
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex((i) => Math.min(i + 1, Math.max(suggestions.length - 1, 0)));
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((i) => Math.max(i - 1, 0));
      return;
    }
    if (event.key === "Enter") {
      const pick = suggestions[activeIndex];
      if (pick) {
        event.preventDefault();
        add(pick.userId);
      }
      return;
    }
    if (event.key === "Escape") {
      setQuery("");
    }
  };

  const publisher = currentUserId ? byId.get(currentUserId) : undefined;

  return (
    <div className="share-people" data-disabled={disabled || undefined}>
      <div className="share-people__field" onClick={() => inputRef.current?.focus()}>
        {publisher ? (
          <span className="share-people__chip share-people__chip--fixed">
            <UserAvatar
              imageUrl={publisher.imageUrl}
              displayName={publisher.displayName}
              email={publisher.email}
              size={18}
            />
            <span className="share-people__chip-name">You</span>
          </span>
        ) : null}

        {selected.map((person) => (
          <span key={person.userId} className="share-people__chip">
            <UserAvatar
              imageUrl={person.imageUrl}
              displayName={person.displayName}
              email={person.email}
              size={18}
            />
            <span className="share-people__chip-name">
              @{handles.get(person.userId)}
            </span>
            <button
              type="button"
              className="share-people__chip-remove"
              onClick={() => remove(person.userId)}
              aria-label={`Remove ${person.displayName}`}
              disabled={disabled}
            >
              <svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true">
                <path
                  d="M6 6l12 12M18 6L6 18"
                  stroke="currentColor"
                  strokeWidth="2.2"
                  strokeLinecap="round"
                />
              </svg>
            </button>
          </span>
        ))}

        <input
          ref={inputRef}
          className="share-people__input"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setActiveIndex(0);
          }}
          onKeyDown={onKeyDown}
          placeholder={selected.length === 0 ? "@ mention a teammate" : ""}
          disabled={disabled}
          aria-label="Add a person by name or @handle"
          autoComplete="off"
          spellCheck={false}
        />
      </div>

      {query.trim().length > 0 ? (
        <ul className="share-people__menu" role="listbox">
          {loading ? (
            <li className="share-people__empty">Loading workspace…</li>
          ) : suggestions.length === 0 ? (
            <li className="share-people__empty">No matching teammate</li>
          ) : (
            suggestions.slice(0, 6).map((person, i) => (
              <li key={person.userId}>
                <button
                  type="button"
                  role="option"
                  aria-selected={i === activeIndex}
                  className={`share-people__option${i === activeIndex ? " is-active" : ""}`}
                  onMouseEnter={() => setActiveIndex(i)}
                  onClick={() => add(person.userId)}
                >
                  <UserAvatar
                    imageUrl={person.imageUrl}
                    displayName={person.displayName}
                    email={person.email}
                    size={26}
                  />
                  <span className="share-people__option-text">
                    <span className="share-people__option-name">
                      {person.displayName}
                    </span>
                    <span className="share-people__option-handle">
                      @{handles.get(person.userId)}
                    </span>
                  </span>
                </button>
              </li>
            ))
          )}
        </ul>
      ) : null}
    </div>
  );
}
