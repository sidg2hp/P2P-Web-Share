import { startTransition, useEffect, useRef, useState } from "react";
import { io } from "socket.io-client";

const MAX_FILE_SIZE = 50 * 1024 * 1024;
const CHUNK_SIZE = 32 * 1024;
const BUFFER_THRESHOLD = 256 * 1024;
const SIGNALING_URL =
  import.meta.env.VITE_SIGNALING_URL ?? "http://localhost:4000";

const INITIAL_TRANSFER = {
  direction: "idle",
  fileName: "",
  totalBytes: 0,
  transferredBytes: 0,
  percent: 0,
  speed: 0,
  verifiedChunks: 0,
  totalChunks: 0,
};

function getRoomIdFromLocation() {
  const segments = window.location.pathname.split("/").filter(Boolean);
  if (segments[0] === "room" && segments[1]) {
    return decodeURIComponent(segments[1]);
  }

  return "";
}

function createRoomId() {
  return crypto.randomUUID().split("-")[0].toUpperCase();
}

function formatBytes(bytes) {
  if (!bytes) {
    return "0 B";
  }

  const units = ["B", "KB", "MB", "GB"];
  const exponent = Math.min(
    Math.floor(Math.log(bytes) / Math.log(1024)),
    units.length - 1,
  );
  const value = bytes / 1024 ** exponent;
  return `${value.toFixed(value >= 10 || exponent === 0 ? 0 : 1)} ${units[exponent]}`;
}

function formatSpeed(bytesPerSecond) {
  if (!bytesPerSecond) {
    return "0 MB/s";
  }

  return `${(bytesPerSecond / (1024 * 1024)).toFixed(2)} MB/s`;
}

function safeFileName(fileName) {
  return fileName.replace(/[<>:"/\\|?*\u0000-\u001F]/g, "_");
}

async function sha256Hex(input) {
  const hashBuffer = await crypto.subtle.digest("SHA-256", input);
  return Array.from(new Uint8Array(hashBuffer))
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}

function sendJsonMessage(channel, payload) {
  channel.send(JSON.stringify(payload));
}

function stateLabel(connectionState) {
  switch (connectionState) {
    case "new":
      return "Connection created.";
    case "checking":
      return "Negotiating peer connection...";
    case "connected":
      return "Peer connected.";
    case "disconnected":
      return "Peer temporarily disconnected.";
    case "failed":
      return "Peer connection failed.";
    case "closed":
      return "Peer connection closed.";
    default:
      return "Waiting for activity...";
  }
}

export default function App() {
  const initialRoomId = getRoomIdFromLocation();
  const [role, setRole] = useState(initialRoomId ? "receiver" : "idle");
  const [roomId, setRoomId] = useState(initialRoomId);
  const [shareLink, setShareLink] = useState(
    initialRoomId ? window.location.href : "",
  );
  const [selectedFile, setSelectedFile] = useState(null);
  const [incomingMeta, setIncomingMeta] = useState(null);
  const [connectionStatus, setConnectionStatus] = useState(
    initialRoomId ? "Joining the room..." : "Choose a file to begin.",
  );
  const [error, setError] = useState("");
  const [transfer, setTransfer] = useState(INITIAL_TRANSFER);
  const [isDragging, setIsDragging] = useState(false);
  const [copied, setCopied] = useState(false);
  const [activityLog, setActivityLog] = useState([]);

  const socketRef = useRef(null);
  const peerConnectionRef = useRef(null);
  const dataChannelRef = useRef(null);
  const roomIdRef = useRef(initialRoomId);
  const roleRef = useRef(initialRoomId ? "receiver" : "idle");
  const selectedFileRef = useRef(null);
  const transferStartedRef = useRef(false);
  const transferStartRef = useRef(0);
  const pendingHeaderRef = useRef(null);
  const pendingIceCandidatesRef = useRef([]);
  const messageQueueRef = useRef(Promise.resolve());
  const receivedChunksRef = useRef([]);
  const receivedChunkCountRef = useRef(0);
  const receivedBytesRef = useRef(0);
  const incomingMetaRef = useRef(null);
  const joinedRoomRef = useRef(false);
  const currentDownloadUrlRef = useRef("");

  function addLog(message) {
    const entry = {
      id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
      time: new Date().toLocaleTimeString(),
      message,
    };

    startTransition(() => {
      setActivityLog((current) => [entry, ...current].slice(0, 8));
    });
  }

  function resetIncomingTransfer() {
    pendingHeaderRef.current = null;
    receivedChunksRef.current = [];
    receivedChunkCountRef.current = 0;
    receivedBytesRef.current = 0;
    incomingMetaRef.current = null;
    setIncomingMeta(null);
  }

  function resetTransferState() {
    transferStartedRef.current = false;
    transferStartRef.current = 0;
    messageQueueRef.current = Promise.resolve();
    setTransfer(INITIAL_TRANSFER);
    resetIncomingTransfer();
  }

  function cleanupPeerConnection() {
    if (dataChannelRef.current) {
      dataChannelRef.current.onopen = null;
      dataChannelRef.current.onclose = null;
      dataChannelRef.current.onmessage = null;
      dataChannelRef.current.onerror = null;
      dataChannelRef.current.close();
      dataChannelRef.current = null;
    }

    if (peerConnectionRef.current) {
      peerConnectionRef.current.onicecandidate = null;
      peerConnectionRef.current.ondatachannel = null;
      peerConnectionRef.current.onconnectionstatechange = null;
      peerConnectionRef.current.close();
      peerConnectionRef.current = null;
    }

    pendingIceCandidatesRef.current = [];
  }

  useEffect(() => {
    const socket = io(SIGNALING_URL, {
      transports: ["websocket"],
    });

    socketRef.current = socket;

    socket.on("connect", () => {
      addLog("Connected to the signaling server.");

      if (roleRef.current === "receiver" && roomIdRef.current && !joinedRoomRef.current) {
        joinRoom(roomIdRef.current);
      }
    });

    socket.on("disconnect", () => {
      addLog("Disconnected from the signaling server.");
      setConnectionStatus("Signaling server disconnected.");
    });

    socket.on("peer-joined", async ({ roomId: joinedRoom }) => {
      addLog(`Receiver joined room ${joinedRoom}.`);
      setConnectionStatus("Peer joined. Negotiating direct connection...");

      if (roleRef.current !== "sender") {
        return;
      }

      try {
        const peerConnection =
          peerConnectionRef.current ?? createPeerConnection("sender");
        const offer = await peerConnection.createOffer();
        await peerConnection.setLocalDescription(offer);

        socket.emit("signal", {
          roomId: roomIdRef.current,
          payload: {
            kind: "session-description",
            description: peerConnection.localDescription,
          },
        });
      } catch (signalError) {
        reportError("Unable to create a WebRTC offer.", signalError);
      }
    });

    socket.on("signal", async ({ payload }) => {
      try {
        await handleSignal(payload);
      } catch (signalError) {
        reportError("Failed to process a signaling message.", signalError);
      }
    });

    socket.on("peer-disconnected", () => {
      addLog("The remote peer disconnected.");
      setConnectionStatus("Peer disconnected. The transfer has stopped.");
    });

    return () => {
      socket.disconnect();
      cleanupPeerConnection();

      if (currentDownloadUrlRef.current) {
        URL.revokeObjectURL(currentDownloadUrlRef.current);
      }
    };
  }, []);

  function reportError(message, details) {
    console.error(message, details);
    setError(message);
    setConnectionStatus(message);
    addLog(message);
  }

  function updateTransferMetrics(direction, fileName, totalBytes, transferredBytes, totalChunks) {
    const elapsedSeconds = Math.max(
      (performance.now() - transferStartRef.current) / 1000,
      0.001,
    );

    setTransfer({
      direction,
      fileName,
      totalBytes,
      transferredBytes,
      percent: totalBytes ? (transferredBytes / totalBytes) * 100 : 0,
      speed: transferredBytes / elapsedSeconds,
      verifiedChunks:
        direction === "receiving"
          ? receivedChunkCountRef.current
          : Math.min(
              totalChunks,
              Math.ceil(transferredBytes / CHUNK_SIZE),
            ),
      totalChunks,
    });
  }

  function attachDataChannel(channel) {
    dataChannelRef.current = channel;
    channel.binaryType = "arraybuffer";
    channel.bufferedAmountLowThreshold = BUFFER_THRESHOLD;

    channel.onopen = () => {
      addLog("WebRTC data channel is open.");
      setConnectionStatus("Direct P2P channel established.");

      if (roleRef.current === "sender" && selectedFileRef.current && !transferStartedRef.current) {
        void sendFile();
      }
    };

    channel.onclose = () => {
      addLog("WebRTC data channel closed.");
      setConnectionStatus("Direct channel closed.");
    };

    channel.onerror = (event) => {
      reportError("The WebRTC data channel encountered an error.", event);
    };

    channel.onmessage = (event) => {
      messageQueueRef.current = messageQueueRef.current
        .then(async () => {
          if (typeof event.data === "string") {
            const payload = JSON.parse(event.data);
            await handleControlMessage(payload);
            return;
          }

          await handleIncomingChunk(event.data);
        })
        .catch((messageError) => {
          reportError(
            "Failed to process an incoming data channel message.",
            messageError,
          );
        });
    };
  }

  function createPeerConnection(nextRole) {
    cleanupPeerConnection();

    const peerConnection = new RTCPeerConnection({
      iceServers: [
        { urls: "stun:stun.l.google.com:19302" },
        { urls: "stun:stun1.l.google.com:19302" },
      ],
    });

    peerConnection.onicecandidate = (event) => {
      if (!event.candidate || !socketRef.current) {
        return;
      }

      socketRef.current.emit("signal", {
        roomId: roomIdRef.current,
        payload: {
          kind: "ice-candidate",
          candidate: event.candidate,
        },
      });
    };

    peerConnection.onconnectionstatechange = () => {
      const { connectionState } = peerConnection;
      setConnectionStatus(stateLabel(connectionState));
      addLog(stateLabel(connectionState));

      if (connectionState === "failed") {
        setError("Peer connection failed. Please refresh and try again.");
      }
    };

    if (nextRole === "receiver") {
      peerConnection.ondatachannel = (event) => {
        addLog("Incoming data channel received.");
        attachDataChannel(event.channel);
      };
    } else {
      const channel = peerConnection.createDataChannel("file-transfer", {
        ordered: true,
      });
      attachDataChannel(channel);
    }

    peerConnectionRef.current = peerConnection;
    return peerConnection;
  }

  async function flushPendingIceCandidates(peerConnection) {
    const candidates = [...pendingIceCandidatesRef.current];
    pendingIceCandidatesRef.current = [];

    for (const candidate of candidates) {
      await peerConnection.addIceCandidate(candidate);
    }
  }

  async function handleSignal(payload) {
    if (!payload) {
      return;
    }

    if (payload.kind === "session-description") {
      const description = new RTCSessionDescription(payload.description);
      const peerConnection =
        peerConnectionRef.current ??
        createPeerConnection(
          description.type === "offer" ? "receiver" : roleRef.current,
        );

      await peerConnection.setRemoteDescription(description);
      await flushPendingIceCandidates(peerConnection);

      if (description.type === "offer") {
        const answer = await peerConnection.createAnswer();
        await peerConnection.setLocalDescription(answer);

        socketRef.current.emit("signal", {
          roomId: roomIdRef.current,
          payload: {
            kind: "session-description",
            description: peerConnection.localDescription,
          },
        });
      }

      return;
    }

    if (payload.kind === "ice-candidate") {
      const peerConnection = peerConnectionRef.current;
      if (!peerConnection) {
        pendingIceCandidatesRef.current.push(payload.candidate);
        return;
      }

      if (peerConnection.remoteDescription) {
        await peerConnection.addIceCandidate(payload.candidate);
      } else {
        pendingIceCandidatesRef.current.push(payload.candidate);
      }
    }
  }

  async function waitForBufferedAmount(channel) {
    while (channel.bufferedAmount > BUFFER_THRESHOLD) {
      await new Promise((resolve) => {
        const handler = () => {
          channel.removeEventListener("bufferedamountlow", handler);
          resolve();
        };

        channel.addEventListener("bufferedamountlow", handler);
      });
    }
  }

  async function sendFile() {
    const file = selectedFileRef.current;
    const channel = dataChannelRef.current;

    if (!file || !channel || channel.readyState !== "open") {
      return;
    }

    setError("");
    transferStartedRef.current = true;
    transferStartRef.current = performance.now();

    try {
      addLog(`Computing manifest for ${file.name}.`);

      const wholeFileBuffer = await file.arrayBuffer();
      const wholeFileHash = await sha256Hex(wholeFileBuffer);
      const totalChunks = Math.ceil(file.size / CHUNK_SIZE);

      setIncomingMeta(null);
      updateTransferMetrics("sending", file.name, file.size, 0, totalChunks);

      sendJsonMessage(channel, {
        type: "meta",
        fileName: file.name,
        fileSize: file.size,
        fileType: file.type,
        fileHash: wholeFileHash,
        chunkSize: CHUNK_SIZE,
        totalChunks,
      });

      addLog(`Sending ${totalChunks} verified chunks directly to the peer.`);

      let transferredBytes = 0;

      for (let index = 0; index < totalChunks; index += 1) {
        const start = index * CHUNK_SIZE;
        const end = Math.min(file.size, start + CHUNK_SIZE);
        const chunkBuffer = await file.slice(start, end).arrayBuffer();
        const chunkHash = await sha256Hex(chunkBuffer);

        sendJsonMessage(channel, {
          type: "chunk-header",
          index,
          size: chunkBuffer.byteLength,
          hash: chunkHash,
        });

        await waitForBufferedAmount(channel);
        channel.send(chunkBuffer);

        transferredBytes += chunkBuffer.byteLength;
        updateTransferMetrics(
          "sending",
          file.name,
          file.size,
          transferredBytes,
          totalChunks,
        );
      }

      sendJsonMessage(channel, {
        type: "complete",
        fileHash: wholeFileHash,
        totalChunks,
      });

      setConnectionStatus("All chunks sent. Waiting for receiver verification...");
      addLog("Sender finished streaming the file.");
    } catch (transferError) {
      reportError("The file transfer failed before completion.", transferError);
      transferStartedRef.current = false;
    }
  }

  async function handleControlMessage(payload) {
    switch (payload.type) {
      case "meta": {
        resetIncomingTransfer();
        incomingMetaRef.current = payload;
        setIncomingMeta(payload);
        transferStartRef.current = performance.now();
        setConnectionStatus(`Receiving ${payload.fileName}...`);
        addLog(`Ready to receive ${payload.fileName}.`);
        updateTransferMetrics(
          "receiving",
          payload.fileName,
          payload.fileSize,
          0,
          payload.totalChunks,
        );
        break;
      }
      case "chunk-header": {
        pendingHeaderRef.current = payload;
        break;
      }
      case "complete": {
        await finalizeDownload(payload);
        break;
      }
      case "transfer-ack": {
        setConnectionStatus("Receiver verified the file and completed the download.");
        addLog("Receiver confirmed the final SHA-256 digest.");
        break;
      }
      case "chunk-nack": {
        reportError(
          `Receiver rejected chunk ${payload.index + 1} because the hash did not match.`,
        );
        break;
      }
      default:
        break;
    }
  }

  async function handleIncomingChunk(arrayBuffer) {
    const header = pendingHeaderRef.current;
    const meta = incomingMetaRef.current;
    const channel = dataChannelRef.current;

    if (!header || !meta) {
      reportError("Received binary data without a matching transfer header.");
      return;
    }

    const actualHash = await sha256Hex(arrayBuffer);

    if (actualHash !== header.hash) {
      pendingHeaderRef.current = null;
      sendJsonMessage(channel, {
        type: "chunk-nack",
        index: header.index,
        expectedHash: header.hash,
        actualHash,
      });
      reportError(`Chunk ${header.index + 1} failed SHA-256 verification.`);
      return;
    }

    receivedChunksRef.current[header.index] = arrayBuffer;
    receivedChunkCountRef.current += 1;
    receivedBytesRef.current += arrayBuffer.byteLength;
    pendingHeaderRef.current = null;

    updateTransferMetrics(
      "receiving",
      meta.fileName,
      meta.fileSize,
      receivedBytesRef.current,
      meta.totalChunks,
    );
  }

  async function finalizeDownload(payload) {
    const meta = incomingMetaRef.current;

    if (!meta) {
      reportError("Transfer completion arrived before file metadata.");
      return;
    }

    if (receivedChunkCountRef.current !== payload.totalChunks) {
      reportError("The transfer ended before all chunks were verified.");
      return;
    }

    const blob = new Blob(receivedChunksRef.current, {
      type: meta.fileType || "application/octet-stream",
    });
    const finalHash = await sha256Hex(await blob.arrayBuffer());

    if (finalHash !== payload.fileHash) {
      reportError("The completed file failed final SHA-256 verification.");
      return;
    }

    if (currentDownloadUrlRef.current) {
      URL.revokeObjectURL(currentDownloadUrlRef.current);
    }

    currentDownloadUrlRef.current = URL.createObjectURL(blob);

    const anchor = document.createElement("a");
    anchor.href = currentDownloadUrlRef.current;
    anchor.download = safeFileName(meta.fileName);
    document.body.append(anchor);
    anchor.click();
    anchor.remove();

    updateTransferMetrics(
      "receiving",
      meta.fileName,
      meta.fileSize,
      meta.fileSize,
      meta.totalChunks,
    );

    setConnectionStatus("Transfer complete. File verified and downloaded.");
    addLog("Receiver reassembled the file and verified the final digest.");

    if (dataChannelRef.current?.readyState === "open") {
      sendJsonMessage(dataChannelRef.current, {
        type: "transfer-ack",
        fileHash: finalHash,
      });
    }
  }

  function chooseFile(file) {
    if (!file) {
      return;
    }

    if (file.size > MAX_FILE_SIZE) {
      setError("Please choose a file smaller than 50 MB for the MVP flow.");
      setSelectedFile(null);
      selectedFileRef.current = null;
      return;
    }

    resetTransferState();
    setError("");
    setSelectedFile(file);
    selectedFileRef.current = file;
    setConnectionStatus("File loaded. Create a share room when you are ready.");
    addLog(`Selected ${file.name} (${formatBytes(file.size)}).`);
  }

  function handleFileInput(event) {
    const file = event.target.files?.[0];
    chooseFile(file);
  }

  function handleDrop(event) {
    event.preventDefault();
    setIsDragging(false);
    chooseFile(event.dataTransfer.files?.[0]);
  }

  function handleDragOver(event) {
    event.preventDefault();
    setIsDragging(true);
  }

  function handleDragLeave(event) {
    event.preventDefault();
    setIsDragging(false);
  }

  function createRoom() {
    if (!selectedFileRef.current) {
      setError("Choose a file before creating a room.");
      return;
    }

    if (!socketRef.current?.connected) {
      setError("The signaling server is not connected yet.");
      return;
    }

    const nextRoomId = createRoomId();
    const nextShareLink = `${window.location.origin}/room/${nextRoomId}`;

    setError("");
    setRole("sender");
    roleRef.current = "sender";
    setRoomId(nextRoomId);
    roomIdRef.current = nextRoomId;
    setShareLink(nextShareLink);
    joinedRoomRef.current = true;
    resetTransferState();
    createPeerConnection("sender");

    socketRef.current.emit("create-room", { roomId: nextRoomId }, (response) => {
      if (!response.ok) {
        reportError(response.error, response);
        joinedRoomRef.current = false;
        return;
      }

      addLog(`Room ${nextRoomId} created. Share the link with your peer.`);
      setConnectionStatus("Room created. Waiting for a receiver to join.");
    });
  }

  function joinRoom(nextRoomId) {
    if (!socketRef.current?.connected) {
      return;
    }

    joinedRoomRef.current = true;
    roleRef.current = "receiver";
    setRole("receiver");
    roomIdRef.current = nextRoomId;
    setRoomId(nextRoomId);
    setShareLink(window.location.href);
    setError("");
    resetTransferState();
    createPeerConnection("receiver");

    socketRef.current.emit("join-room", { roomId: nextRoomId }, (response) => {
      if (!response.ok) {
        reportError(response.error, response);
        joinedRoomRef.current = false;
        return;
      }

      addLog(`Joined room ${nextRoomId}.`);
      setConnectionStatus("Joined room. Waiting for the sender to start.");
    });
  }

  async function copyShareLink() {
    try {
      await navigator.clipboard.writeText(shareLink);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch (copyError) {
      reportError("Could not copy the room link to the clipboard.", copyError);
    }
  }

  const canCreateRoom = Boolean(selectedFile) && role !== "receiver";
  const progressWidth = `${Math.min(100, transfer.percent).toFixed(1)}%`;

  return (
    <main className="shell">
      <section className="panel app-grid">
        <div className="hero-block">
          <p className="eyebrow">Direct Browser-to-Browser File Transfer</p>
          <h1>P2P Web Share</h1>
          <p className="lede">
            A lightweight WebRTC file-sharing room that uses Socket.io only for
            signaling and keeps every file chunk out of the server.
          </p>

          <div className="hero-metrics">
            <article className="metric-card">
              <span className="metric-label">Role</span>
              <strong>{role === "receiver" ? "Receiver" : role === "sender" ? "Sender" : "Waiting"}</strong>
            </article>
            <article className="metric-card">
              <span className="metric-label">Room</span>
              <strong>{roomId || "Not created yet"}</strong>
            </article>
            <article className="metric-card">
              <span className="metric-label">Connection</span>
              <strong>{connectionStatus}</strong>
            </article>
          </div>

          {role !== "receiver" && (
            <div
              className={`dropzone ${isDragging ? "is-dragging" : ""}`}
              onDrop={handleDrop}
              onDragOver={handleDragOver}
              onDragLeave={handleDragLeave}
            >
              <input
                className="file-input"
                type="file"
                id="file-picker"
                onChange={handleFileInput}
              />
              <label htmlFor="file-picker" className="dropzone-label">
                <span>Drop a file here or click to browse</span>
                <small>MVP-safe size: under 50 MB</small>
              </label>
            </div>
          )}

          {selectedFile && role !== "receiver" && (
            <div className="file-summary">
              <div>
                <span className="metric-label">Selected file</span>
                <strong>{selectedFile.name}</strong>
              </div>
              <div>
                <span className="metric-label">Size</span>
                <strong>{formatBytes(selectedFile.size)}</strong>
              </div>
            </div>
          )}

          {role !== "receiver" && (
            <div className="button-row">
              <button
                className="primary-button"
                type="button"
                onClick={createRoom}
                disabled={!canCreateRoom}
              >
                Create share room
              </button>
            </div>
          )}

          {shareLink && role === "sender" && (
            <div className="share-card">
              <span className="metric-label">Invite link</span>
              <div className="share-row">
                <code>{shareLink}</code>
                <button type="button" className="ghost-button" onClick={copyShareLink}>
                  {copied ? "Copied" : "Copy link"}
                </button>
              </div>
            </div>
          )}

          {role === "receiver" && (
            <div className="share-card">
              <span className="metric-label">Receiver room</span>
              <p className="receiver-copy">
                Opened from an invite link. Waiting for the sender to complete
                the direct handshake and start streaming the file.
              </p>
            </div>
          )}

          {error && (
            <div className="alert alert-error" role="alert">
              {error}
            </div>
          )}
        </div>

        <div className="side-column">
          <section className="panel-card">
            <div className="section-heading">
              <h2>Transfer monitor</h2>
              <span>{transfer.direction === "idle" ? "Idle" : transfer.direction}</span>
            </div>

            <div className="progress-shell" aria-hidden="true">
              <div className="progress-fill" style={{ width: progressWidth }} />
            </div>

            <div className="progress-copy">
              <strong>{transfer.percent.toFixed(1)}%</strong>
              <span>{transfer.fileName || incomingMeta?.fileName || "No active file"}</span>
            </div>

            <div className="stats-grid">
              <article className="stat-tile">
                <span>Transferred</span>
                <strong>{formatBytes(transfer.transferredBytes)}</strong>
              </article>
              <article className="stat-tile">
                <span>Total size</span>
                <strong>{formatBytes(transfer.totalBytes)}</strong>
              </article>
              <article className="stat-tile">
                <span>Speed</span>
                <strong>{formatSpeed(transfer.speed)}</strong>
              </article>
              <article className="stat-tile">
                <span>Verified chunks</span>
                <strong>
                  {transfer.verifiedChunks}/{transfer.totalChunks}
                </strong>
              </article>
            </div>
          </section>

          <section className="panel-card">
            <div className="section-heading">
              <h2>Activity log</h2>
              <span>Latest events</span>
            </div>

            <div className="log-list">
              {activityLog.length === 0 ? (
                <p className="empty-copy">Events will appear here as the room becomes active.</p>
              ) : (
                activityLog.map((entry) => (
                  <article key={entry.id} className="log-item">
                    <span>{entry.time}</span>
                    <p>{entry.message}</p>
                  </article>
                ))
              )}
            </div>
          </section>
        </div>
      </section>
    </main>
  );
}
