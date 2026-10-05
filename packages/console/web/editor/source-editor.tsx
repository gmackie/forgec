import React, { useEffect, useRef } from "react";
import { EditorState, Compartment } from "@codemirror/state";
import {
  EditorView,
  keymap,
  lineNumbers,
  highlightActiveLine,
} from "@codemirror/view";
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
} from "@codemirror/commands";
import {
  StreamLanguage,
  syntaxHighlighting,
  defaultHighlightStyle,
} from "@codemirror/language";

const keywords = new Set(
  "export module import from as resource blob cache view projection function workflow channel source type shape enum lifecycle initial terminal capability includes read create update delete filter order actions for use uses sends errors input output list find by asc desc unique within rule where cron timezone return step sleep wait parallel choice if else purpose dataClass extends content mediaTypes maxBytes".split(
    " ",
  ),
);
export const forgeLanguage = StreamLanguage.define({
  token(stream) {
    if (stream.eatSpace()) return null;
    if (stream.match("//")) {
      stream.skipToEnd();
      return "comment";
    }
    if (stream.match(/"(?:[^"\\]|\\.)*(?:"|$)/)) return "string";
    if (stream.match(/@[A-Za-z_][\w.]*/)) return "meta";
    if (stream.match(/\b\d+(?:\.\d+)?(?:ms|s|m|h|d|%)?\b/)) return "number";
    if (stream.match(/[A-Za-z_][\w.]*/)) {
      const word = stream.current();
      if (keywords.has(word)) return "keyword";
      if (
        [
          "text",
          "integer",
          "decimal",
          "boolean",
          "id",
          "date",
          "datetime",
          "email",
          "url",
          "duration",
        ].includes(word)
      )
        return "typeName";
      if (["true", "false", "null"].includes(word)) return "atom";
      return /^[A-Z]/.test(word) ? "typeName" : "variableName";
    }
    stream.next();
    return "punctuation";
  },
});

export function SourceEditor({
  value,
  readOnly = false,
  onCommit,
}: {
  value: string;
  readOnly?: boolean;
  onCommit?: (value: string) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const latest = useRef({ value, onCommit });
  latest.current = { value, onCommit };
  const editable = useRef(new Compartment());
  useEffect(() => {
    const editor = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: value,
        extensions: [
          lineNumbers(),
          history(),
          highlightActiveLine(),
          forgeLanguage,
          syntaxHighlighting(defaultHighlightStyle),
          keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
          editable.current.of([
            EditorState.readOnly.of(readOnly),
            EditorView.editable.of(!readOnly),
            EditorView.contentAttributes.of({
              "aria-readonly": String(readOnly),
            }),
          ]),
          EditorView.contentAttributes.of({
            "aria-label": "Forge source",
            role: "textbox",
            "aria-multiline": "true",
          }),
          EditorView.lineWrapping,
          EditorView.domEventHandlers({
            blur: () => {
              const text = editor.state.doc.toString();
              if (!editor.state.readOnly && text !== latest.current.value)
                latest.current.onCommit?.(text);
            },
            keydown: (event) => {
              if (event.key !== "Escape") return false;
              editor.dispatch({
                changes: {
                  from: 0,
                  to: editor.state.doc.length,
                  insert: latest.current.value,
                },
              });
              editor.contentDOM.blur();
              return true;
            },
          }),
          EditorView.theme({
            "&": {
              fontSize: "14px",
              border: "1px solid #d5dbe5",
              borderRadius: "8px",
              background: "#fff",
              color: "#172031",
            },
            ".cm-scroller": {
              fontFamily: "Menlo, monospace",
              minHeight: "240px",
              maxHeight: "65vh",
            },
            ".cm-content": { padding: "12px 0" },
            ".cm-gutters": {
              border: "none",
              background: "#f4f6fa",
              color: "#677185",
            },
          }),
        ],
      }),
    });
    view.current = editor;
    return () => {
      editor.destroy();
      view.current = null;
    };
  }, []);
  useEffect(() => {
    const editor = view.current;
    if (editor && editor.state.doc.toString() !== value)
      editor.dispatch({
        changes: { from: 0, to: editor.state.doc.length, insert: value },
      });
  }, [value]);
  useEffect(() => {
    view.current?.dispatch({
      effects: editable.current.reconfigure([
        EditorState.readOnly.of(readOnly),
        EditorView.editable.of(!readOnly),
        EditorView.contentAttributes.of({ "aria-readonly": String(readOnly) }),
      ]),
    });
  }, [readOnly]);
  return <div className="forge-source-editor" ref={host} />;
}
