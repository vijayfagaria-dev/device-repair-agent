import { useCallback, useEffect, useMemo, useRef } from "react";
import type { Server } from "../config";
import {
  ChatClientMessageType,
  InputKind,
  type InputResponse,
} from "@device-repair/shared/protocol";
import type { SendInput, Ui } from "../state/ui";
import { chatRetryNotice } from "../lib/closeCodes";
import { permanentCloseNotice } from "../lib/sessionState";
import { handleChatMessage, newReplayTracker } from "../transport/chatMessages";
import { closeQuietly, socketUrl } from "../transport/socket";
import { uploadFiles } from "../transport/upload";

const FIRST_RETRY_MS = 1000;
const MAX_RETRY_MS = 15000;
const NOT_CONNECTED =
  "Not connected to the server. Please try again in a moment.";

export function useChat(
  ui: Ui,
  server: Server | null,
): { sendInput: SendInput; optOut: () => void } {
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    if (!server) return;
    const url = socketUrl(server, "/chat");
    let retryDelay = FIRST_RETRY_MS;
    let ws: WebSocket | null = null;
    let timer: ReturnType<typeof setTimeout>;

    const retry = (code = 0) => {
      ui.setNotice(chatRetryNotice(code, url, Math.round(retryDelay / 1000)));
      timer = setTimeout(connect, retryDelay);
      retryDelay = Math.min(retryDelay * 2, MAX_RETRY_MS);
    };

    const connect = () => {
      try {
        ws = new WebSocket(url);
      } catch {
        retry();
        return;
      }
      ws.onopen = () => {
        retryDelay = FIRST_RETRY_MS;
        ui.setNotice(null);
      };
      const replay = newReplayTracker(); // each connection starts with a replay
      ws.onmessage = ({ data }) => handleChatMessage(ui, data, replay);
      ws.onclose = ({ code }) => {
        // 4400/4403 can't be fixed by reconnecting (protocol.md §6): stop and say why. Everything else retries.
        const permanent = permanentCloseNotice(code);
        if (permanent) ui.setNotice(permanent);
        else retry(code);
      };
      wsRef.current = ws;
    };

    // Deferred so StrictMode's dev double-mount doesn't open and immediately abort a socket.
    timer = setTimeout(connect, 0);
    return () => {
      clearTimeout(timer);
      if (ws) closeQuietly(ws);
      wsRef.current = null;
    };
  }, [ui, server]);

  const sendInput = useCallback<SendInput>(
    async (spec, value, files) => {
      if (!server) throw new Error(NOT_CONNECTED);
      openSocket(wsRef.current);
      const msg: InputResponse = {
        type: ChatClientMessageType.INPUT_RESPONSE,
        requestId: spec.id,
        field: spec.field,
        value:
          spec.kind === InputKind.FILE
            ? await uploadFiles(server, files, Boolean(spec.multiple))
            : value,
      };
      openSocket(wsRef.current).send(JSON.stringify(msg));
    },
    [server],
  );

  // The header's Stop button (P4-T05): the server answers with a "Stop your claim?" card; nothing ends without Yes.
  const optOut = useCallback(() => {
    try {
      openSocket(wsRef.current).send(JSON.stringify({ type: ChatClientMessageType.OPT_OUT }));
    } catch (err) {
      ui.setNotice(err instanceof Error ? err.message : NOT_CONNECTED);
    }
  }, [ui]);

  const controls = useMemo(() => ({ sendInput, optOut }), [sendInput, optOut]);

  return controls;
}

function openSocket(ws: WebSocket | null): WebSocket {
  if (ws?.readyState !== WebSocket.OPEN) throw new Error(NOT_CONNECTED);
  return ws;
}
