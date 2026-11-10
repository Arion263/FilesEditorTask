"use client";

import { EditorContent, useEditor, useEditorState, type Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Placeholder from "@tiptap/extension-placeholder";
import Image from "@tiptap/extension-image";
import { useEffect } from "react";

interface Props {
  initialContent: string;
  editable: boolean;
  onChange: (html: string) => void;
  onReady?: (editor: Editor) => void;
  toolbarExtras?: React.ReactNode;
}

/**
 * TipTap (ProseMirror) editor. Content is exchanged as HTML; the server
 * sanitises it against the same set of tags this toolbar can produce.
 */
export function RichTextEditor({ initialContent, editable, onChange, onReady, toolbarExtras }: Props) {
  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: { levels: [1, 2, 3] },
        link: { openOnClick: false, autolink: true },
      }),
      Placeholder.configure({ placeholder: "Start writing…" }),
      Image.configure({
        allowBase64: true,
        HTMLAttributes: {
          class: "rounded-lg max-w-full h-auto my-3 border border-slate-200 shadow-xs",
        },
      }),
    ],
    content: initialContent,
    editable,
    immediatelyRender: false, // avoid SSR hydration mismatches
    editorProps: {
      attributes: {
        class: "doc-content focus:outline-none",
        "aria-label": "Document content",
      },
    },
    onUpdate: ({ editor }) => onChange(editor.getHTML()),
  });

  useEffect(() => {
    editor?.setEditable(editable);
  }, [editor, editable]);

  useEffect(() => {
    if (editor && onReady) onReady(editor);
  }, [editor, onReady]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {editable && editor && <Toolbar editor={editor} extras={toolbarExtras} />}
      <div className="flex-1 overflow-y-auto bg-slate-100 px-2 py-6 sm:px-6 sm:py-10">
        <div className="mx-auto min-h-[70vh] max-w-[816px] rounded-sm bg-white px-6 py-10 shadow-sm ring-1 ring-slate-200 sm:px-16 sm:py-14">
          {editor ? (
            <EditorContent editor={editor} />
          ) : (
            <div className="space-y-3">
              <div className="h-6 w-1/2 animate-pulse rounded bg-slate-100" />
              <div className="h-4 w-full animate-pulse rounded bg-slate-100" />
              <div className="h-4 w-5/6 animate-pulse rounded bg-slate-100" />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

const BLOCK_OPTIONS = [
  { value: "p", label: "Normal text" },
  { value: "1", label: "Heading 1" },
  { value: "2", label: "Heading 2" },
  { value: "3", label: "Heading 3" },
] as const;

function Toolbar({ editor, extras }: { editor: Editor; extras?: React.ReactNode }) {
  // useEditorState re-renders the toolbar only when these values change.
  const s = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      bold: e.isActive("bold"),
      italic: e.isActive("italic"),
      underline: e.isActive("underline"),
      strike: e.isActive("strike"),
      bullet: e.isActive("bulletList"),
      ordered: e.isActive("orderedList"),
      quote: e.isActive("blockquote"),
      block: e.isActive("heading", { level: 1 })
        ? "1"
        : e.isActive("heading", { level: 2 })
          ? "2"
          : e.isActive("heading", { level: 3 })
            ? "3"
            : "p",
      canUndo: e.can().undo(),
      canRedo: e.can().redo(),
    }),
  });

  const chain = () => editor.chain().focus();

  return (
    <div
      role="toolbar"
      aria-label="Formatting"
      className="flex flex-wrap items-center gap-1 border-b border-slate-200 bg-white px-3 py-1.5"
    >
      <ToolButton label="Undo (Ctrl+Z)" disabled={!s.canUndo} onClick={() => chain().undo().run()}>
        ↶
      </ToolButton>
      <ToolButton label="Redo (Ctrl+Y)" disabled={!s.canRedo} onClick={() => chain().redo().run()}>
        ↷
      </ToolButton>
      <Divider />
      <select
        aria-label="Text style"
        className="h-8 rounded-md border border-transparent bg-transparent px-2 text-sm text-slate-700 hover:bg-slate-100 focus:border-blue-400 focus:outline-none"
        value={s.block}
        onChange={(e) => {
          const v = e.target.value;
          if (v === "p") chain().setParagraph().run();
          else chain().setHeading({ level: Number(v) as 1 | 2 | 3 }).run();
        }}
      >
        {BLOCK_OPTIONS.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <Divider />
      <ToolButton label="Bold (Ctrl+B)" active={s.bold} onClick={() => chain().toggleBold().run()}>
        <span className="font-bold">B</span>
      </ToolButton>
      <ToolButton
        label="Italic (Ctrl+I)"
        active={s.italic}
        onClick={() => chain().toggleItalic().run()}
      >
        <span className="font-serif italic">I</span>
      </ToolButton>
      <ToolButton
        label="Underline (Ctrl+U)"
        active={s.underline}
        onClick={() => chain().toggleUnderline().run()}
      >
        <span className="underline">U</span>
      </ToolButton>
      <ToolButton
        label="Strikethrough"
        active={s.strike}
        onClick={() => chain().toggleStrike().run()}
      >
        <span className="line-through">S</span>
      </ToolButton>
      <Divider />
      <ToolButton
        label="Bulleted list"
        active={s.bullet}
        onClick={() => chain().toggleBulletList().run()}
      >
        <ListIcon ordered={false} />
      </ToolButton>
      <ToolButton
        label="Numbered list"
        active={s.ordered}
        onClick={() => chain().toggleOrderedList().run()}
      >
        <ListIcon ordered />
      </ToolButton>
      <ToolButton label="Quote" active={s.quote} onClick={() => chain().toggleBlockquote().run()}>
        ❝
      </ToolButton>
      {extras && (
        <>
          <Divider />
          {extras}
        </>
      )}
    </div>
  );
}

function ToolButton({
  label,
  active,
  disabled,
  onClick,
  children,
}: {
  label: string;
  active?: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={active}
      disabled={disabled}
      onMouseDown={(e) => e.preventDefault()} // keep editor selection
      onClick={onClick}
      className={`grid h-8 min-w-8 place-items-center rounded-md px-1.5 text-sm transition disabled:opacity-30 ${
        active ? "bg-blue-100 text-blue-700" : "text-slate-700 hover:bg-slate-100"
      }`}
    >
      {children}
    </button>
  );
}

function Divider() {
  return <span className="mx-1 h-5 w-px bg-slate-200" aria-hidden />;
}

function ListIcon({ ordered }: { ordered: boolean }) {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
      <line x1="9" y1="6" x2="20" y2="6" />
      <line x1="9" y1="12" x2="20" y2="12" />
      <line x1="9" y1="18" x2="20" y2="18" />
      {ordered ? (
        <g stroke="none" fill="currentColor" fontSize="7" fontFamily="sans-serif">
          <text x="2" y="8.5">1</text>
          <text x="2" y="14.5">2</text>
          <text x="2" y="20.5">3</text>
        </g>
      ) : (
        <g fill="currentColor" stroke="none">
          <circle cx="4" cy="6" r="1.5" />
          <circle cx="4" cy="12" r="1.5" />
          <circle cx="4" cy="18" r="1.5" />
        </g>
      )}
    </svg>
  );
}
