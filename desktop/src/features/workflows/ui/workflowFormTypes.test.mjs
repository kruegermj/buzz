import assert from "node:assert/strict";
import { test } from "node:test";

import {
  formStateToYaml,
  isThreadReplyEligibleTrigger,
  withTriggerType,
  yamlToFormState,
  DEFAULT_FORM_STATE,
} from "./workflowFormTypes.ts";

function sendMessageState(overrides) {
  return {
    ...DEFAULT_FORM_STATE,
    name: "Auto Reply",
    trigger: { on: "message_posted", filter: "trigger_is_reply == false" },
    steps: [
      {
        id: "step_1",
        action: "send_message",
        text: "pre-written reply",
        ...overrides,
      },
    ],
  };
}

test("reply_in_thread is emitted only when the checkbox is on", () => {
  const withReply = formStateToYaml(sendMessageState({ replyInThread: true }));
  assert.match(withReply, /reply_in_thread: true/);

  const withoutReply = formStateToYaml(
    sendMessageState({ replyInThread: false }),
  );
  assert.doesNotMatch(withoutReply, /reply_in_thread/);

  const unset = formStateToYaml(sendMessageState({}));
  assert.doesNotMatch(unset, /reply_in_thread/);
});

test("switching from Message Posted clears reply_in_thread before save", () => {
  const messagePosted = sendMessageState({ replyInThread: true });

  for (const triggerType of ["schedule", "webhook"]) {
    const switched = withTriggerType(messagePosted, triggerType);
    assert.equal(switched.trigger.on, triggerType);
    assert.equal(switched.steps[0].replyInThread, false);
    assert.doesNotMatch(formStateToYaml(switched), /reply_in_thread/);
  }
});

test("reply_in_thread eligibility follows trigger capability", () => {
  assert.equal(isThreadReplyEligibleTrigger("message_posted"), true);
  assert.equal(isThreadReplyEligibleTrigger("schedule"), false);
  assert.equal(isThreadReplyEligibleTrigger("webhook"), false);
});
test("reply_in_thread round-trips YAML -> form -> YAML", () => {
  const yaml = formStateToYaml(sendMessageState({ replyInThread: true }));
  const parsed = yamlToFormState(yaml);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.state.steps[0].replyInThread, true);

  const reserialized = formStateToYaml(parsed.state);
  assert.match(reserialized, /reply_in_thread: true/);
});

test("absent reply_in_thread parses as false", () => {
  const yaml = [
    "name: No Reply",
    "trigger:",
    "  on: message_posted",
    "steps:",
    "  - id: step_1",
    "    action: send_message",
    "    text: hi",
    "",
  ].join("\n");
  const parsed = yamlToFormState(yaml);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.state.steps[0].replyInThread, false);
});
