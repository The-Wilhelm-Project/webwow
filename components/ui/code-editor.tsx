'use client';

import React, { useEffect, useInsertionEffect, useRef } from 'react';
import Editor from 'react-simple-code-editor';
import Prism from 'prismjs';
import 'prismjs/components/prism-markup';
import 'prismjs/components/prism-clike';
import 'prismjs/components/prism-javascript';
import 'prismjs/components/prism-css';
import 'prismjs/components/prism-css-extras';
import { cn } from '@/lib/utils';

interface CodeEditorProps {
  value: string;
  onValueChange?: (value: string) => void;
  readOnly?: boolean;
  placeholder?: string;
  className?: string;
  autoFocus?: boolean;
  /** Exposes the internal textarea (e.g. to insert text at the cursor). */
  textareaRef?: React.RefObject<HTMLTextAreaElement | null>;
}

/** Renders leading spaces of each line as middle dots for visible indentation. */
function showIndentDots(html: string): string {
  return html.replace(/^ +/gm, (spaces) =>
    `<span class="code-editor-indent">${'·'.repeat(spaces.length)}</span>`,
  );
}

function highlightHtml(code: string): string {
  return showIndentDots(Prism.highlight(code, Prism.languages.markup, 'markup'));
}

const STYLE_ID = 'code-editor-prism-theme';
const prismCss = `
.code-editor-root .token.tag { color: #e06c75; }
.code-editor-root .token.attr-name { color: #d19a66; }
.code-editor-root .token.attr-value { color: #98c379; }
.code-editor-root .token.punctuation { color: #abb2bf; }
.code-editor-root .token.comment { color: #5c6370; font-style: italic; }
.code-editor-root .token.entity { color: #d19a66; }
.code-editor-root .token.doctype { color: #5c6370; }
.code-editor-root .token.prolog { color: #5c6370; }
.code-editor-root .token.cdata { color: #5c6370; }
.code-editor-root .token.keyword { color: #c678dd; }
.code-editor-root .token.boolean,
.code-editor-root .token.number,
.code-editor-root .token.constant { color: #d19a66; }
.code-editor-root .token.string,
.code-editor-root .token.char,
.code-editor-root .token.attr-value .token.value { color: #98c379; }
.code-editor-root .token.function,
.code-editor-root .token.class-name { color: #61afef; }
.code-editor-root .token.operator { color: #56b6c2; }
.code-editor-root .token.property { color: #56b6c2; }
.code-editor-root .token.selector { color: #e5c07b; }
.code-editor-root .token.selector .token.class,
.code-editor-root .token.selector .token.id { color: #d19a66; }
.code-editor-root .token.selector .token.pseudo-class,
.code-editor-root .token.selector .token.pseudo-element,
.code-editor-root .token.selector .token.attribute { color: #56b6c2; }
.code-editor-root .token.selector .token.combinator { color: #abb2bf; }
.code-editor-root .token.builtin { color: #56b6c2; }
.code-editor-root .token.regex,
.code-editor-root .token.important { color: #d19a66; }
.code-editor-root .token.variable { color: #e06c75; }
.code-editor-root .token.parameter { color: #e06c75; }
.code-editor-root .token.function-variable { color: #61afef; }
.code-editor-root .code-editor-indent { color: #454b57; }
`;

let styleInjected = false;
function ensurePrismStyles() {
  if (styleInjected) return;
  if (typeof document === 'undefined') return;
  if (document.getElementById(STYLE_ID)) { styleInjected = true; return; }
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = prismCss;
  document.head.appendChild(style);
  styleInjected = true;
}

const noop = () => {};

export function CodeEditor({
  value,
  onValueChange,
  readOnly = false,
  placeholder = '',
  className,
  autoFocus = false,
  textareaRef,
}: CodeEditorProps) {
  useInsertionEffect(ensurePrismStyles, []);

  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const textarea = rootRef.current?.querySelector('textarea') ?? null;
    if (textarea) textarea.spellcheck = false;
    if (textareaRef) textareaRef.current = textarea;
  });

  return (
    <div
      ref={rootRef}
      className={cn(
        'code-editor-root rounded-lg border border-transparent bg-input overflow-auto font-mono text-xs',
        readOnly && 'cursor-default',
        className,
      )}
    >
      <Editor
        value={value}
        onValueChange={onValueChange ?? noop}
        highlight={highlightHtml}
        padding={12}
        readOnly={readOnly}
        placeholder={placeholder}
        autoFocus={autoFocus}
        textareaClassName="outline-none !min-h-[inherit]"
        preClassName="!min-h-[inherit]"
        style={{
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
          fontSize: '11px',
          lineHeight: '1.6',
          minHeight: 'inherit',
        }}
      />
    </div>
  );
}
