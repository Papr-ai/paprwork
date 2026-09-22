/**
 * SharePeoplePicker — choose which workspace people can open this app.
 *
 * Modelled on the Google Docs share dialog, because that is the interaction
 * people already know: a search field to add someone, then an explicit list of
 * who currently has access.
 *
 * The previous version put chips *inside* the input. That reads as a tag
 * editor, not a permission list — you could not tell who had access without
 * parsing the contents of a text field, and it gave no home to the owner.
 * Access is a list of people, so it is rendered as a list of people.
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
  /** Publisher — always retains access, shown as a non-removable owner row. */
  currentUserId?: string | null;
}

function SearchGlyph() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
      <path
        d="M7.2 12.4a5.2 5.2 0 1 0 0-10.4 5.2 5.2 0 0 0 0 10.4ZM11 11l3 3"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
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

  const owner = currentUserId ? byId.get(currentUserId) : undefined;

  const granted = useMemo(
    () => value.map((id) => byId.get(id)).filter(Boolean) as SharePeopleMember[],
    [value, byId],
  );

  const suggestions = useMemo(() => {
    const chosen = new Set(value);
    return members
      .filter(
        (m) =>
          m.userId !== currentUserId &&
          !chosen.has(m.userId) &&
          matchesMentionQuery(
            { userId: m.userId, displayName: m.displayName, email: m.email },
            handles.get(m.userId) ?? "",
            query,
          ),
      )
      .slice(0, 5);
  }, [members, value, currentUserId, handles, query]);

  const menuOpen = query.trim().length > 0;

  const add = (userId: string) => {
    if (!value.includes(userId)) onChange([...value, userId]);
    setQuery("");
    setActiveIndex(0);
    inputRef.current?.focus();
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (!menuOpen) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex((i) => Math.min(i + 1, suggestions.length - 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((i) => Math.max(i - 1, 0));
    } else if (event.key === "Enter") {
      const pick = suggestions[activeIndex];
      if (pick) {
        event.preventDefault();
        add(pick.userId);
      }
    } else if (event.key === "Escape") {
      setQuery("");
    }
  };

  return (
    <div className="people-picker" data-disabled={disabled || undefined}>
      <div className="people-picker__search">
        <span className="people-picker__search-icon">
          <SearchGlyph />
        </span>
        <input
          ref={inputRef}
          className="people-picker__input"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setActiveIndex(0);
          }}
          onKeyDown={onKeyDown}
          placeholder="Add people by name or email"
          disabled={disabled}
          aria-label="Add people by name or email"
          autoComplete="off"
          spellCheck={false}
        />
      </div>

      {menuOpen ? (
        <ul className="people-picker__menu" role="listbox">
          {loading ? (
            <li className="people-picker__empty">Loading workspace…</li>
          ) : suggestions.length === 0 ? (
            <li className="people-picker__empty">No matching teammate</li>
          ) : (
            suggestions.map((person, i) => (
              <li key={person.userId}>
                <button
                  type="button"
                  role="option"
                  aria-selected={i === activeIndex}
                  className={`people-picker__option${i === activeIndex ? " is-active" : ""}`}
                  onMouseEnter={() => setActiveIndex(i)}
                  onClick={() => add(person.userId)}
                >
                  <UserAvatar
                    imageUrl={person.imageUrl}
                    displayName={person.displayName}
                    email={person.email}
                    size={28}
                  />
                  <span className="people-picker__person">
                    <span className="people-picker__name">{person.displayName}</span>
                    <span className="people-picker__sub">{person.email}</span>
                  </span>
                </button>
              </li>
            ))
          )}
        </ul>
      ) : null}

      <div className="people-picker__access">
        <div className="people-picker__access-title">People with access</div>
        <ul className="people-picker__access-list">
          {owner ? (
            <li className="people-picker__row">
              <UserAvatar
                imageUrl={owner.imageUrl}
                displayName={owner.displayName}
                email={owner.email}
                size={28}
              />
              <span className="people-picker__person">
                <span className="people-picker__name">{owner.displayName} (you)</span>
                <span className="people-picker__sub">{owner.email}</span>
              </span>
              <span className="people-picker__badge">Owner</span>
            </li>
          ) : null}

          {granted.map((person) => (
            <li key={person.userId} className="people-picker__row">
              <UserAvatar
                imageUrl={person.imageUrl}
                displayName={person.displayName}
                email={person.email}
                size={28}
              />
              <span className="people-picker__person">
                <span className="people-picker__name">{person.displayName}</span>
                <span className="people-picker__sub">{person.email}</span>
              </span>
              <button
                type="button"
                className="people-picker__remove"
                onClick={() => onChange(value.filter((id) => id !== person.userId))}
                disabled={disabled}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>

        {granted.length === 0 ? (
          <p className="people-picker__hint">
            No one else yet — add a teammate above, or nobody but you will be
            able to open this app.
          </p>
        ) : null}
      </div>
    </div>
  );
}
