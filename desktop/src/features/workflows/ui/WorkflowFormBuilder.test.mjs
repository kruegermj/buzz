import assert from "node:assert/strict";
import { after, afterEach, before, test } from "node:test";

import { JSDOM } from "jsdom";

import { WorkflowFormBuilder } from "./WorkflowFormBuilder.tsx";

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost",
});

before(() => {
  Object.assign(globalThis, {
    document: dom.window.document,
    getComputedStyle: dom.window.getComputedStyle,
    HTMLElement: dom.window.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true,
    window: dom.window,
  });
});

afterEach(async () => {
  const { cleanup } = await import("@testing-library/react");
  cleanup();
});

after(() => dom.window.close());

const MESSAGE_POSTED_WORKFLOW = [
  "name: Auto Reply",
  "trigger:",
  "  on: message_posted",
  "steps:",
  "  - id: step_1",
  "    action: send_message",
  "    text: pre-written reply",
  "",
].join("\n");

for (const triggerType of ["schedule", "webhook"]) {
  test(`switching Message Posted to ${triggerType} clears reply_in_thread before save`, async () => {
    const { fireEvent, render, screen } = await import(
      "@testing-library/react"
    );
    const React = await import("react");
    const emittedYaml = [];

    render(
      React.createElement(WorkflowFormBuilder, {
        yaml: MESSAGE_POSTED_WORKFLOW,
        onChange: (yaml) => emittedYaml.push(yaml),
      }),
    );

    fireEvent.click(
      screen.getByRole("checkbox", {
        name: "Reply to triggering message in thread",
      }),
    );
    assert.match(emittedYaml.at(-1), /reply_in_thread: true/);

    fireEvent.change(document.querySelector("#wf-trigger-type"), {
      target: { value: triggerType },
    });

    assert.doesNotMatch(emittedYaml.at(-1), /reply_in_thread/);
    assert.match(emittedYaml.at(-1), new RegExp(`on: ${triggerType}`));
  });
}
