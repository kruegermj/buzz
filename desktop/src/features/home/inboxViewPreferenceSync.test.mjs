import assert from "node:assert/strict";
import test, { mock } from "node:test";

import { relayClient } from "@/shared/api/relayClient";
import { KIND_INBOX_VIEW } from "@/shared/constants/kinds";
import {
  installFakeWindow,
  installTauriMock,
  makeFakeWindow,
} from "@/features/sidebar/lib/sidebarSyncTestHelpers.mjs";
import { InboxViewPreferenceSyncManager } from "./inboxViewPreferenceSync.ts";

test("publishes Inbox view settings as the encrypted inbox-view NIP-78 blob", async () => {
  mock.method(relayClient, "fetchEvents", () => Promise.resolve([]));
  const published = [];
  mock.method(relayClient, "publishEvent", (event) => {
    published.push(event);
    return Promise.resolve();
  });
  const fakeWindow = makeFakeWindow();
  const restoreWindow = installFakeWindow(fakeWindow);
  const tauri = installTauriMock(
    JSON.stringify({ version: 1, filter: "all", unreadOnly: false }),
  );

  try {
    const manager = new InboxViewPreferenceSyncManager(
      "pk-lww",
      "wss://relay.example",
    );
    manager.publishPreference({
      version: 1,
      filter: "mention",
      unreadOnly: true,
    });
    fakeWindow._fireTimer();
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.deepEqual(JSON.parse(tauri.capturedPlaintext()), {
      version: 1,
      filter: "mention",
      unreadOnly: true,
    });
    assert.equal(published.length, 1);
    assert.equal(published[0].kind, KIND_INBOX_VIEW);
    assert.deepEqual(published[0].tags, [
      ["d", "inbox-view"],
      ["t", "inbox-view"],
    ]);
    manager.destroy();
  } finally {
    tauri.restore();
    restoreWindow();
    mock.reset();
  }
});
