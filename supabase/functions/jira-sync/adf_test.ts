import { adfToText } from "./adf.ts";

function assertEqual(actual: string, expected: string): void {
  if (actual !== expected) {
    throw new Error(`expected ${JSON.stringify(expected)} but got ${JSON.stringify(actual)}`);
  }
}

Deno.test("paragraphs and headings are separated by a blank line", () => {
  const text = adfToText({
    type: "doc",
    content: [
      { type: "paragraph", content: [{ type: "text", text: "Hello" }] },
      { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Title" }] },
    ],
  });
  assertEqual(text, "Hello\n\nTitle");
});

Deno.test("lists use bullet and ordered markers", () => {
  const text = adfToText({
    type: "doc",
    content: [
      {
        type: "bulletList",
        content: [
          { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "Apples" }] }] },
          { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "Bananas" }] }] },
        ],
      },
      {
        type: "orderedList",
        attrs: { order: 1 },
        content: [
          { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "First" }] }] },
          { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "Second" }] }] },
        ],
      },
    ],
  });
  assertEqual(text, "- Apples\n- Bananas\n\n1. First\n2. Second");
});

Deno.test("ordered lists honor a starting number", () => {
  const text = adfToText({
    type: "orderedList",
    attrs: { order: 3 },
    content: [
      { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "Third" }] }] },
    ],
  });
  assertEqual(text, "3. Third");
});

Deno.test("table rows are cells joined by a pipe", () => {
  const text = adfToText({
    type: "table",
    content: [
      {
        type: "tableRow",
        content: [
          { type: "tableHeader", content: [{ type: "paragraph", content: [{ type: "text", text: "A" }] }] },
          { type: "tableHeader", content: [{ type: "paragraph", content: [{ type: "text", text: "B" }] }] },
        ],
      },
      {
        type: "tableRow",
        content: [
          { type: "tableCell", content: [{ type: "paragraph", content: [{ type: "text", text: "C" }] }] },
          { type: "tableCell", content: [{ type: "paragraph", content: [{ type: "text", text: "D" }] }] },
        ],
      },
    ],
  });
  assertEqual(text, "A | B\nC | D");
});

Deno.test("links, mentions, emoji, code, and media keep their text", () => {
  const text = adfToText({
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [
          {
            type: "text",
            text: "Docs",
            marks: [{ type: "link", attrs: { href: "https://example.com/docs" } }],
          },
          { type: "text", text: " " },
          { type: "mention", attrs: { text: "Ada Lovelace" } },
          { type: "text", text: " " },
          { type: "emoji", attrs: { shortName: ":smile:", text: ":-)" } },
        ],
      },
      { type: "codeBlock", content: [{ type: "text", text: "const n = 1;" }] },
      { type: "mediaSingle", content: [{ type: "media", attrs: { alt: "photo.png", id: "abc" } }] },
      { type: "media", attrs: { id: "abc-123" } },
    ],
  });
  assertEqual(
    text,
    "Docs (https://example.com/docs) @Ada Lovelace :-)\n\nconst n = 1;\n\n[attachment: photo.png]\n\n[attachment: abc-123]",
  );
});

Deno.test("emoji without text falls back to the short name", () => {
  assertEqual(adfToText({ type: "emoji", attrs: { shortName: ":bug:" } }), ":bug:");
});

Deno.test("hard breaks stay inside the paragraph", () => {
  assertEqual(
    adfToText({
      type: "paragraph",
      content: [
        { type: "text", text: "a" },
        { type: "hardBreak" },
        { type: "text", text: "b" },
      ],
    }),
    "a\nb",
  );
});

Deno.test("unknown wrappers still yield their text", () => {
  assertEqual(
    adfToText({
      type: "layout",
      content: [{ type: "paragraph", content: [{ type: "text", text: "Kept" }] }],
    }),
    "Kept",
  );
});

Deno.test("empty and non-document values are empty strings", () => {
  assertEqual(adfToText(null), "");
  assertEqual(adfToText("plain"), "");
  assertEqual(adfToText({ type: "doc", content: [] }), "");
});
