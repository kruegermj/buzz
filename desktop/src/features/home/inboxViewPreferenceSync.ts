import { relayClient } from "@/shared/api/relayClient";
import {
  nip44DecryptFromSelf,
  nip44EncryptToSelf,
  signRelayEvent,
} from "@/shared/api/tauri";
import type { RelayEvent } from "@/shared/api/types";
import { KIND_INBOX_VIEW } from "@/shared/constants/kinds";
import {
  advanceWatermark,
  readWatermark,
  runBootstrap,
  type FetchResult,
} from "@/features/sidebar/lib/sidebarSyncWatermark";
import {
  parseInboxViewPreference,
  type InboxViewPreference,
} from "./inboxViewPreference";

const D_TAG = "inbox-view";
const BLOB_TYPE = D_TAG;
const DEBOUNCE_MS = 2_000;

/** A decrypted Inbox view preference and its relay ordering metadata. */
export type RemoteInboxViewPreference = {
  preference: InboxViewPreference;
  createdAt: number;
  eventId: string;
};

async function decryptAndParse(
  event: RelayEvent,
): Promise<RemoteInboxViewPreference | null> {
  try {
    const plaintext = await nip44DecryptFromSelf(event.content);
    const preference = parseInboxViewPreference(JSON.parse(plaintext));
    if (!preference) return null;
    return { preference, createdAt: event.created_at, eventId: event.id };
  } catch {
    return null;
  }
}

/**
 * Syncs Inbox filter settings through encrypted NIP-78 app data, matching the
 * channel-sort preference's debounced, whole-blob last-write-wins behavior.
 */
export class InboxViewPreferenceSyncManager {
  private debounceTimer: number | null = null;
  private destroyed = false;
  private lastPublishedPreference: InboxViewPreference | null = null;
  private lastRemoteCreatedAt: number;
  private pendingPreference: InboxViewPreference | null = null;
  private pubkey: string;
  private relayUrl: string;

  constructor(pubkey: string, relayUrl: string) {
    this.pubkey = pubkey;
    this.relayUrl = relayUrl;
    this.lastRemoteCreatedAt = readWatermark(pubkey, BLOB_TYPE, relayUrl);
  }

  async fetchRemotePreference(): Promise<
    FetchResult<RemoteInboxViewPreference>
  > {
    try {
      const events = await relayClient.fetchEvents({
        kinds: [KIND_INBOX_VIEW],
        authors: [this.pubkey],
        "#d": [D_TAG],
        limit: 1,
      });
      if (events.length === 0 || events[0].pubkey !== this.pubkey) {
        return { status: "absent" };
      }
      const event = events[0];
      this.recordRemoteHead(event.created_at);
      const result = await decryptAndParse(event);
      if (!result) {
        return { status: "failed", createdAt: event.created_at };
      }
      return {
        status: "found",
        data: result,
        createdAt: result.createdAt,
        eventId: result.eventId,
      };
    } catch {
      return { status: "failed" };
    }
  }

  private recordRemoteHead(createdAt: number): void {
    if (createdAt > this.lastRemoteCreatedAt) {
      this.lastRemoteCreatedAt = createdAt;
    }
    advanceWatermark(this.pubkey, BLOB_TYPE, this.relayUrl, createdAt);
  }

  cancelPendingPublish(): void {
    if (this.debounceTimer !== null) {
      window.clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
  }

  getPendingPreference(): InboxViewPreference | null {
    return this.pendingPreference;
  }

  publishPreference(preference: InboxViewPreference): void {
    this.pendingPreference = preference;
    if (this.debounceTimer !== null) {
      window.clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = window.setTimeout(() => {
      this.debounceTimer = null;
      void this.doPublish(preference);
    }, DEBOUNCE_MS);
  }

  private async fetchOwnBlobBeforePublish(
    preference: InboxViewPreference,
  ): Promise<InboxViewPreference> {
    try {
      const events = await relayClient.fetchEvents({
        kinds: [KIND_INBOX_VIEW],
        authors: [this.pubkey],
        "#d": [D_TAG],
        limit: 1,
      });
      if (events.length === 0 || events[0].pubkey !== this.pubkey) {
        return preference;
      }
      const event = events[0];
      const headBeforeFetch = this.lastRemoteCreatedAt;
      this.recordRemoteHead(event.created_at);
      const remote = await decryptAndParse(event);
      if (!remote) return preference;
      return remote.createdAt > headBeforeFetch
        ? remote.preference
        : preference;
    } catch {
      return preference;
    }
  }

  private isIdenticalToLastPublished(preference: InboxViewPreference): boolean {
    return (
      this.lastPublishedPreference?.filter === preference.filter &&
      this.lastPublishedPreference.unreadOnly === preference.unreadOnly
    );
  }

  private async doPublish(preference: InboxViewPreference): Promise<void> {
    try {
      const merged = await this.fetchOwnBlobBeforePublish(preference);
      if (this.destroyed) return;
      if (this.isIdenticalToLastPublished(merged)) {
        this.pendingPreference = null;
        return;
      }
      const ciphertext = await nip44EncryptToSelf(JSON.stringify(merged));
      const createdAt = Math.max(
        Math.floor(Date.now() / 1_000),
        this.lastRemoteCreatedAt + 1,
      );
      const event = await signRelayEvent({
        kind: KIND_INBOX_VIEW,
        content: ciphertext,
        createdAt,
        tags: [
          ["d", D_TAG],
          ["t", D_TAG],
        ],
      });
      if (this.destroyed) return;
      await relayClient.publishEvent(
        event,
        "Timed out publishing Inbox view preferences.",
        "Failed to publish Inbox view preferences.",
      );
      this.recordRemoteHead(event.created_at);
      this.lastPublishedPreference = merged;
      this.pendingPreference = null;
    } catch (error) {
      console.warn("[inboxViewPreferenceSync] publish failed:", error);
    }
  }

  async subscribe(
    onUpdate: (remote: RemoteInboxViewPreference) => void,
  ): Promise<() => Promise<void>> {
    return relayClient.subscribeLive(
      {
        kinds: [KIND_INBOX_VIEW],
        authors: [this.pubkey],
        "#d": [D_TAG],
        limit: 0,
      },
      (event: RelayEvent) => {
        if (event.pubkey !== this.pubkey) return;
        this.recordRemoteHead(event.created_at);
        void decryptAndParse(event).then((result) => {
          if (result) onUpdate(result);
        });
      },
    );
  }

  async bootstrap(localPreference: InboxViewPreference) {
    const fetchResult = await this.fetchRemotePreference();
    return runBootstrap({
      fetchResult,
      lastHead: this.lastRemoteCreatedAt,
      localStore: localPreference,
      isLocalNonEmpty: (preference) =>
        preference.filter !== "all" || preference.unreadOnly,
      publishFn: (preference) => this.publishPreference(preference),
    });
  }

  destroy(): void {
    this.destroyed = true;
    this.cancelPendingPublish();
    this.pendingPreference = null;
  }
}
