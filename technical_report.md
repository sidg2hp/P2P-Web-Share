# P2P Web Share - Technical Report

## Overview
This technical report details the architecture, features, and implementation specifics of the P2P Web Share project. The project is a lightweight, decentralized peer-to-peer file-sharing web application built to facilitate direct browser-to-browser file transfers without storing file data on any central server.

## Architecture
The application employs a hybrid decentralized architecture comprising two main layers:
1.  **Frontend Client (React.js):** Manages the user interface, file drag-and-drop interactions, and the WebRTC data channel establishment.
2.  **Signaling Server (Node.js + Socket.io):** A minimal backend that purely coordinates the initial WebRTC connection handshake (SDP offers/answers and ICE candidates).

By decoupling the signaling from the actual file transfer, the system ensures high privacy and zero bandwidth cost on the server side for file data transmission.

## Technology Stack
*   **Frontend UI:** React.js, Custom CSS (Glassmorphism, Dark mode aesthetics)
*   **P2P Communication:** Native WebRTC API (RTCPeerConnection, RTCDataChannel)
*   **Backend Signaling:** Node.js, Express.js, Socket.io
*   **Cryptography:** Web Crypto API (`crypto.subtle`)

## Feature Implementation Details

### 1. Share Room Creation
*   **Mechanism:** Users drag and drop a file into the designated zone. The application validates the file against a `50MB` size limit (to stay within standard browser memory bounds for the MVP).
*   **Room ID:** A secure, unique Room ID is generated on the client side using `crypto.randomUUID()`.
*   **Outcome:** An invite link is formed and displayed, ready to be shared with the receiver.

### 2. Signaling Handshake
*   **Mechanism:** The sender and receiver connect to the central Node.js signaling server.
*   **Process:** 
    *   The sender emits a `create-room` event.
    *   The receiver opens the invite link and emits a `join-room` event.
    *   The server notifies the sender via `peer-joined`.
    *   The sender creates an SDP offer, and the two peers exchange SDP descriptions and ICE candidates through the `signal` event.
*   **Constraint Verification:** The signaling server handles only metadata. It enforces a strict 2-peer limit per room and does not interact with the `file-transfer` data channel.

### 3. Direct P2P Transfer
*   **Mechanism:** Once the WebRTC handshake completes, the sender opens an `RTCDataChannel` (configured with `ordered: true`).
*   **Streaming:** The file is not read fully into RAM at once. Instead, it is sliced into `32KB` chunks using the `Blob.slice()` and `arrayBuffer()` API to maintain performance and prevent UI thread blocking.

### 4. Cryptographic Chunk Verification
*   **Integrity Guarantee:** To ensure zero data corruption, the application implements SHA-256 hashing.
*   **Process:**
    *   The sender computes the hash of the whole file and each individual chunk using `crypto.subtle.digest("SHA-256", buffer)`.
    *   A `chunk-header` containing the chunk index and hash is sent prior to sending the binary chunk.
    *   The receiver intercepts the binary data, computes its hash, and verifies it against the header.
    *   Upon receiving all chunks, the receiver computes a final hash of the reassembled file and compares it to the initial metadata hash.

### 5. Progress Monitoring & UI
*   **Metrics:** A real-time monitor tracks the transfer. State updates compute the `percent` completion, total `transferredBytes`, and transfer `speed` (MB/s).
*   **Resilience:** The connection status dynamically shifts from "Negotiating" to "Transferring" to "Complete".

### 6. Graceful Disconnect Handling
*   **Mechanism:** Both the signaling server and the React client listen for connection drops.
*   **Execution:** If a user closes the tab or loses internet, the server fires a `peer-disconnected` event. The client catches this and the WebRTC `onconnectionstatechange` event, gracefully halting the transfer and alerting the remaining user.

### 7. Auto-Download
*   **Mechanism:** Once the receiver verifies the final chunk, the `ArrayBuffer` sequence is compiled into a `Blob`.
*   **Execution:** The app generates a temporary `URL.createObjectURL(blob)`, assigns it to a hidden anchor (`<a>`) tag, triggers a programmatic `.click()`, and finally revokes the object URL to free memory.

## Conclusion
The P2P Web Share MVP fulfills all mandatory objectives of a secure, serverless file-transfer tool. By leveraging the browser's native WebRTC and Crypto APIs, the application provides an efficient, reliable, and aesthetically modern solution to decentralized file sharing.
