import { useState } from "react";
import { sessionLink } from "../../lib/closeCodes";
import { CallState, isInCall, type CallStatus } from "../../state/conversation";
import { AvatarIcon, PhoneIcon } from "../icons";
import { CallTimer } from "./CallTimer";
import { MicMeter } from "./MicMeter";

const HEADPHONES_HINT = "Tip: use headphones, so the assistant doesn't hear itself.";

interface Props {
  call: CallStatus;
  notice: string | null;
  onCall: () => void;
  /** The Stop button (P4-T05); absent in demo mode and when the claim isn't active. */
  onStop?: () => void;
  /** Offers the copy-link button (open this claim's chat on a phone, P4-T06). */
  shareable?: boolean;
}

export function Header({ call, notice, onCall, onStop, shareable = false }: Props) {
  const inCall = isInCall(call.state);
  const [copied, setCopied] = useState(false);

  const copyLink = async () => {
    const link = sessionLink(location.href);
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // No clipboard access (an insecure context or a denied permission): let the user copy it by hand.
      window.prompt("Copy this link to open the claim on another device:", link);
    }
  };

  return (
    <>
      <header className="topbar">
        <div className="avatar" aria-hidden="true"><AvatarIcon /></div>
        <div className="titles">
          <h1>Assistant</h1>
          <span className="status" data-state={call.state}>
            <span className="status-text" role="status" title={call.text}>{call.text}</span>
            {call.connectedAt !== null && <CallTimer since={call.connectedAt} />}
          </span>
        </div>
        {shareable && (
          <button className="text-btn" type="button" onClick={copyLink} title="Copy a link to this claim, e.g. to continue on your phone">
            {copied ? "Copied" : "Copy link"}
          </button>
        )}
        {onStop && (
          <button className="text-btn stop-btn" type="button" onClick={onStop} title="Stop this claim (you'll be asked to confirm)">
            Stop
          </button>
        )}
        <button
          className={`call-btn${inCall ? " hangup" : ""}`}
          type="button"
          aria-label={inCall ? "Hang up" : "Start call"}
          title="Use headphones; browser echo cancellation is best-effort."
          disabled={call.disabled}
          onClick={onCall}
        >
          <PhoneIcon />
        </button>
        <MicMeter />
      </header>
      {notice && <p className="notice" role="status">{notice}</p>}
      {call.state === CallState.IDLE && !call.disabled && <p className="hint">{HEADPHONES_HINT}</p>}
    </>
  );
}
