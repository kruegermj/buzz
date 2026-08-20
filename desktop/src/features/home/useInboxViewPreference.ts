import * as React from "react";

import type { InboxFilter } from "@/features/home/lib/inbox";
import { relayClient } from "@/shared/api/relayClient";
import {
  DEFAULT_INBOX_VIEW_PREFERENCE,
  inboxViewPreferenceStorageKey,
  readInboxViewPreference,
  writeInboxViewPreference,
  type InboxViewPreference,
} from "./inboxViewPreference";
import {
  InboxViewPreferenceSyncManager,
  type RemoteInboxViewPreference,
} from "./inboxViewPreferenceSync";

/** State and mutations exposed to the mounted Inbox surface. */
export type InboxViewPreferenceController = {
  filter: InboxFilter;
  setFilter: (filter: InboxFilter) => void;
  setUnreadOnly: (unreadOnly: boolean) => void;
  unreadOnly: boolean;
};

/**
 * Persistent Inbox view preferences scoped by pubkey and relay. localStorage
 * is the instant/offline cache; encrypted NIP-78 is the cross-client source.
 */
export function useInboxViewPreference(
  pubkey: string | undefined,
  relayUrl?: string,
): InboxViewPreferenceController {
  const [preference, setPreference] = React.useState<InboxViewPreference>(() =>
    pubkey
      ? readInboxViewPreference(pubkey, relayUrl)
      : DEFAULT_INBOX_VIEW_PREFERENCE,
  );
  const managerRef = React.useRef<InboxViewPreferenceSyncManager | null>(null);
  const lastAppliedRemoteTs = React.useRef(0);
  const lastAppliedEventId = React.useRef("");

  React.useEffect(() => {
    if (!pubkey || !relayUrl) {
      setPreference(DEFAULT_INBOX_VIEW_PREFERENCE);
      lastAppliedRemoteTs.current = 0;
      lastAppliedEventId.current = "";
      return;
    }
    setPreference(readInboxViewPreference(pubkey, relayUrl));
    lastAppliedRemoteTs.current = 0;
    lastAppliedEventId.current = "";
    managerRef.current = new InboxViewPreferenceSyncManager(pubkey, relayUrl);
    return () => {
      managerRef.current?.destroy();
      managerRef.current = null;
    };
  }, [pubkey, relayUrl]);

  React.useEffect(() => {
    if (!pubkey) return;
    const key = inboxViewPreferenceStorageKey(pubkey, relayUrl);
    const handler = (event: StorageEvent) => {
      if (event.key !== key) return;
      setPreference(readInboxViewPreference(pubkey, relayUrl));
    };
    window.addEventListener("storage", handler);
    return () => window.removeEventListener("storage", handler);
  }, [pubkey, relayUrl]);

  const applyRemote = React.useCallback(
    (
      remote: RemoteInboxViewPreference,
    ): ((previous: InboxViewPreference) => InboxViewPreference) => {
      return (previous) => {
        if (!pubkey) return previous;
        if (remote.createdAt < lastAppliedRemoteTs.current) return previous;
        if (
          remote.createdAt === lastAppliedRemoteTs.current &&
          remote.eventId <= lastAppliedEventId.current
        ) {
          return previous;
        }
        lastAppliedRemoteTs.current = remote.createdAt;
        lastAppliedEventId.current = remote.eventId;
        managerRef.current?.cancelPendingPublish();
        if (!writeInboxViewPreference(pubkey, remote.preference, relayUrl)) {
          return previous;
        }
        return remote.preference;
      };
    },
    [pubkey, relayUrl],
  );

  React.useEffect(() => {
    if (!pubkey || !relayUrl) return;
    let cancelled = false;
    const local = readInboxViewPreference(pubkey, relayUrl);
    void managerRef.current?.bootstrap(local).then((result) => {
      if (cancelled) return;
      if (result.action === "apply-remote") {
        setPreference(applyRemote(result.data));
      }
    });
    return () => {
      cancelled = true;
    };
  }, [pubkey, relayUrl, applyRemote]);

  React.useEffect(() => {
    if (!pubkey) return;
    let unsubscribe: (() => Promise<void>) | null = null;
    let cancelled = false;
    void managerRef.current
      ?.subscribe((remote) => {
        if (!cancelled) setPreference(applyRemote(remote));
      })
      .then((dispose) => {
        if (cancelled) {
          void dispose();
        } else {
          unsubscribe = dispose;
        }
      });
    return () => {
      cancelled = true;
      if (unsubscribe) void unsubscribe();
    };
  }, [pubkey, applyRemote]);

  React.useEffect(() => {
    if (!pubkey) return;
    let cancelled = false;
    const unsubscribe = relayClient.subscribeToReconnects(() => {
      void managerRef.current?.fetchRemotePreference().then((result) => {
        if (cancelled) return;
        if (result.status === "found") {
          setPreference(applyRemote(result.data));
        }
        const pending = managerRef.current?.getPendingPreference();
        if (pending) managerRef.current?.publishPreference(pending);
      });
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [pubkey, applyRemote]);

  const updatePreference = React.useCallback(
    (patch: Partial<Pick<InboxViewPreference, "filter" | "unreadOnly">>) => {
      if (!pubkey) return;
      setPreference((previous) => {
        const next = { ...previous, ...patch };
        if (!writeInboxViewPreference(pubkey, next, relayUrl)) return previous;
        managerRef.current?.publishPreference(next);
        return next;
      });
    },
    [pubkey, relayUrl],
  );

  const setFilter = React.useCallback(
    (filter: InboxFilter) => updatePreference({ filter }),
    [updatePreference],
  );
  const setUnreadOnly = React.useCallback(
    (unreadOnly: boolean) => updatePreference({ unreadOnly }),
    [updatePreference],
  );

  return {
    filter: preference.filter,
    setFilter,
    setUnreadOnly,
    unreadOnly: preference.unreadOnly,
  };
}
