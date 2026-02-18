/**
 * SlashCommand TipTap Extension
 *
 * Ported from Paprwork V1 BlockEditor.jsx slash command system.
 * Uses @tiptap/suggestion + tippy.js for positioning.
 */

import React, { useState, useEffect, useImperativeHandle, forwardRef } from "react";
import { Extension } from "@tiptap/core";
import { ReactRenderer } from "@tiptap/react";
import Suggestion from "@tiptap/suggestion";
import type { SuggestionOptions, SuggestionProps, SuggestionKeyDownProps } from "@tiptap/suggestion";
import tippy from "tippy.js";
import type { Instance as TippyInstance } from "tippy.js";
import { PluginKey } from "@tiptap/pm/state";

// ---------- Command items ----------

interface SlashCommandItem {
  title: string;
  description: string;
  icon: string;
  command: (opts: { editor: SuggestionProps["editor"]; range: SuggestionProps["range"] }) => void;
}

function getSlashCommands(query: string): SlashCommandItem[] {
  const items: SlashCommandItem[] = [
    {
      title: "Heading 1",
      description: "Large section heading",
      icon: "H1",
      command: ({ editor, range }) => {
        editor.chain().focus().deleteRange(range).setNode("heading", { level: 1 }).run();
      },
    },
    {
      title: "Heading 2",
      description: "Medium section heading",
      icon: "H2",
      command: ({ editor, range }) => {
        editor.chain().focus().deleteRange(range).setNode("heading", { level: 2 }).run();
      },
    },
    {
      title: "Heading 3",
      description: "Small section heading",
      icon: "H3",
      command: ({ editor, range }) => {
        editor.chain().focus().deleteRange(range).setNode("heading", { level: 3 }).run();
      },
    },
    {
      title: "Bullet List",
      description: "Create a bulleted list",
      icon: "•",
      command: ({ editor, range }) => {
        editor.chain().focus().deleteRange(range).toggleBulletList().run();
      },
    },
    {
      title: "Numbered List",
      description: "Create a numbered list",
      icon: "1.",
      command: ({ editor, range }) => {
        editor.chain().focus().deleteRange(range).toggleOrderedList().run();
      },
    },
    {
      title: "Quote",
      description: "Insert a quote block",
      icon: "❝",
      command: ({ editor, range }) => {
        editor.chain().focus().deleteRange(range).toggleBlockquote().run();
      },
    },
    {
      title: "Code Block",
      description: "Insert a code block",
      icon: "</>",
      command: ({ editor, range }) => {
        editor.chain().focus().deleteRange(range).toggleCodeBlock().run();
      },
    },
    {
      title: "Horizontal Rule",
      description: "Insert a divider line",
      icon: "—",
      command: ({ editor, range }) => {
        editor.chain().focus().deleteRange(range).setHorizontalRule().run();
      },
    },
  ];

  if (!query) return items;
  const lower = query.toLowerCase();
  return items.filter((item) => item.title.toLowerCase().includes(lower));
}

// ---------- Menu component ----------

interface CommandsListProps {
  items: SlashCommandItem[];
  command: (item: SlashCommandItem) => void;
}

interface CommandsListRef {
  onKeyDown: (props: SuggestionKeyDownProps) => boolean;
}

const CommandsList = forwardRef<CommandsListRef, CommandsListProps>(
  ({ items, command }, ref) => {
    const [selectedIndex, setSelectedIndex] = useState(0);

    useEffect(() => {
      setSelectedIndex(0);
    }, [items]);

    useImperativeHandle(ref, () => ({
      onKeyDown: ({ event }: SuggestionKeyDownProps) => {
        if (event.key === "ArrowUp") {
          setSelectedIndex((prev) => (prev + items.length - 1) % items.length);
          return true;
        }
        if (event.key === "ArrowDown") {
          setSelectedIndex((prev) => (prev + 1) % items.length);
          return true;
        }
        if (event.key === "Enter") {
          const item = items[selectedIndex];
          if (item) command(item);
          return true;
        }
        return false;
      },
    }));

    if (items.length === 0) {
      return (
        <div className="slash-menu">
          <div className="slash-menu__empty">No results</div>
        </div>
      );
    }

    return (
      <div className="slash-menu">
        {items.map((item, index) => (
          <button
            key={item.title}
            className={`slash-menu__item${index === selectedIndex ? " slash-menu__item--selected" : ""}`}
            onClick={() => command(item)}
            onMouseEnter={() => setSelectedIndex(index)}
          >
            <span className="slash-menu__icon">{item.icon}</span>
            <div className="slash-menu__text">
              <span className="slash-menu__title">{item.title}</span>
              <span className="slash-menu__description">{item.description}</span>
            </div>
          </button>
        ))}
      </div>
    );
  },
);

CommandsList.displayName = "CommandsList";

// ---------- TipTap extension ----------

const slashCommandPluginKey = new PluginKey("slashCommand");

export const SlashCommandExtension = Extension.create({
  name: "slashCommand",

  addProseMirrorPlugins() {
    const suggestionConfig: Omit<SuggestionOptions<SlashCommandItem>, "editor"> = {
      char: "/",
      startOfLine: true,
      pluginKey: slashCommandPluginKey,
      command: ({ editor, range, props: item }) => {
        item.command({ editor, range });
      },
      items: ({ query }) => getSlashCommands(query),
      render: () => {
        let component: ReactRenderer<CommandsListRef> | null = null;
        let popup: TippyInstance[] | null = null;

        return {
          onStart: (props: SuggestionProps<SlashCommandItem>) => {
            component = new ReactRenderer(CommandsList, {
              props: { items: props.items, command: props.command },
              editor: props.editor,
            });

            if (!props.clientRect) return;

            popup = tippy("body", {
              getReferenceClientRect: props.clientRect as () => DOMRect,
              appendTo: () => document.body,
              content: component.element,
              showOnCreate: true,
              interactive: true,
              trigger: "manual",
              placement: "bottom-start",
            });
          },

          onUpdate(props: SuggestionProps<SlashCommandItem>) {
            component?.updateProps({ items: props.items, command: props.command });

            if (!props.clientRect || !popup?.[0]) return;
            popup[0].setProps({
              getReferenceClientRect: props.clientRect as () => DOMRect,
            });
          },

          onKeyDown(props: SuggestionKeyDownProps) {
            if (props.event.key === "Escape") {
              popup?.[0]?.hide();
              return true;
            }
            return component?.ref?.onKeyDown(props) ?? false;
          },

          onExit() {
            popup?.[0]?.destroy();
            component?.destroy();
            popup = null;
            component = null;
          },
        };
      },
    };

    return [
      Suggestion({
        editor: this.editor,
        ...suggestionConfig,
      }),
    ];
  },
});
