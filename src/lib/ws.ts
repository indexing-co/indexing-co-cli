const crypto = require("node:crypto");
const net = require("node:net");
const tls = require("node:tls");
const { Buffer: NodeBuffer } = require("node:buffer");

import { STREAM_CONNECT_TIMEOUT_MS } from "./constants";
import { CliError, EXIT_CODES } from "./errors";

const WEBSOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

type MessageHandler = (payload: string) => void;
type CloseHandler = (code?: number, reason?: string) => void;

export class SimpleWebSocket {
  private socket: any;
  private buffer: any;
  private messageHandler: MessageHandler;
  private closeHandler?: CloseHandler;
  private closed: boolean;

  constructor(socket: any, onMessage: MessageHandler, onClose?: CloseHandler) {
    this.socket = socket;
    this.buffer = NodeBuffer.alloc(0);
    this.messageHandler = onMessage;
    this.closeHandler = onClose;
    this.closed = false;
  }

  ingest(chunk: any): void {
    this.buffer = NodeBuffer.concat([this.buffer, chunk]);

    while (this.buffer.length >= 2) {
      const firstByte = this.buffer[0];
      const secondByte = this.buffer[1];
      const opcode = firstByte & 0x0f;
      const masked = (secondByte & 0x80) === 0x80;
      let payloadLength = secondByte & 0x7f;
      let offset = 2;

      if (payloadLength === 126) {
        if (this.buffer.length < 4) {
          return;
        }
        payloadLength = this.buffer.readUInt16BE(2);
        offset = 4;
      } else if (payloadLength === 127) {
        if (this.buffer.length < 10) {
          return;
        }
        payloadLength = Number(this.buffer.readBigUInt64BE(2));
        offset = 10;
      }

      const maskBytesLength = masked ? 4 : 0;
      if (this.buffer.length < offset + maskBytesLength + payloadLength) {
        return;
      }

      const mask = masked ? this.buffer.slice(offset, offset + 4) : null;
      offset += maskBytesLength;
      const payload = this.buffer.slice(offset, offset + payloadLength);
      this.buffer = this.buffer.slice(offset + payloadLength);

      if (mask) {
        for (let index = 0; index < payload.length; index += 1) {
          payload[index] ^= mask[index % 4];
        }
      }

      if (opcode === 0x1) {
        this.messageHandler(payload.toString("utf8"));
      } else if (opcode === 0x8) {
        const code = payload.length >= 2 ? payload.readUInt16BE(0) : undefined;
        const reason = payload.length > 2 ? payload.slice(2).toString("utf8") : undefined;
        this.closed = true;
        if (this.closeHandler) {
          this.closeHandler(code, reason);
        }
        this.socket.end();
      } else if (opcode === 0x9) {
        this.sendFrame(0xA, payload);
      }
    }
  }

  private sendFrame(opcode: number, payload: any): void {
    const buffer = NodeBuffer.isBuffer(payload) ? payload : NodeBuffer.from(payload || "");
    const parts = [NodeBuffer.from([0x80 | opcode])];
    const mask = crypto.randomBytes(4);

    if (buffer.length < 126) {
      parts.push(NodeBuffer.from([0x80 | buffer.length]));
    } else if (buffer.length < 65536) {
      const header = NodeBuffer.alloc(3);
      header[0] = 0x80 | 126;
      header.writeUInt16BE(buffer.length, 1);
      parts.push(header);
    } else {
      const header = NodeBuffer.alloc(9);
      header[0] = 0x80 | 127;
      header.writeBigUInt64BE(BigInt(buffer.length), 1);
      parts.push(header);
    }

    parts.push(mask);

    const maskedPayload = NodeBuffer.from(buffer);
    for (let index = 0; index < maskedPayload.length; index += 1) {
      maskedPayload[index] ^= mask[index % 4];
    }
    parts.push(maskedPayload);

    this.socket.write(NodeBuffer.concat(parts));
  }

  close(code = 1000, reason = "client closing"): void {
    if (this.closed) {
      return;
    }

    const payload = NodeBuffer.alloc(2 + NodeBuffer.byteLength(reason));
    payload.writeUInt16BE(code, 0);
    payload.write(reason, 2);
    this.sendFrame(0x8, payload);
    this.socket.end();
    this.closed = true;
  }
}

export async function connectWebSocket(
  urlString: string,
  headers: Record<string, string>,
  handlers: { onMessage: MessageHandler; onClose?: CloseHandler },
): Promise<SimpleWebSocket> {
  const url = new URL(urlString);
  const isSecure = url.protocol === "wss:";
  const port = Number(url.port || (isSecure ? "443" : "80"));
  const socket = isSecure
    ? tls.connect({ host: url.hostname, port, servername: url.hostname })
    : net.connect({ host: url.hostname, port });

  return await new Promise<SimpleWebSocket>((resolve, reject) => {
    const key = crypto.randomBytes(16).toString("base64");
    const expectedAccept = crypto.createHash("sha1").update(`${key}${WEBSOCKET_GUID}`).digest("base64");
    let handshakeBuffer = NodeBuffer.alloc(0);
    let connected = false;

    const timeout = setTimeout(() => {
      socket.destroy();
      reject(new CliError(`Timed out connecting to ${urlString}.`, EXIT_CODES.NETWORK));
    }, STREAM_CONNECT_TIMEOUT_MS);

    socket.on("error", (error: Error) => {
      clearTimeout(timeout);
      reject(new CliError(error.message, EXIT_CODES.NETWORK));
    });

    socket.on("connect", () => {
      const requestLines = [
        `GET ${url.pathname || "/"}${url.search} HTTP/1.1`,
        `Host: ${url.host}`,
        "Upgrade: websocket",
        "Connection: Upgrade",
        `Sec-WebSocket-Key: ${key}`,
        "Sec-WebSocket-Version: 13",
        ...Object.entries(headers).map(([header, value]) => `${header}: ${value}`),
        "",
        "",
      ];

      socket.write(requestLines.join("\r\n"));
    });

    socket.on("data", (chunk: any) => {
      if (connected) {
        return;
      }

      handshakeBuffer = NodeBuffer.concat([handshakeBuffer, chunk]);
      const boundary = handshakeBuffer.indexOf("\r\n\r\n");
      if (boundary === -1) {
        return;
      }

      const responseHead = handshakeBuffer.slice(0, boundary).toString("utf8");
      const remainder = handshakeBuffer.slice(boundary + 4);
      const lines = responseHead.split("\r\n");
      const statusLine = lines[0] || "";

      if (!statusLine.includes("101")) {
        clearTimeout(timeout);
        reject(new CliError(`WebSocket handshake failed: ${statusLine || "unknown response"}`, EXIT_CODES.NETWORK));
        socket.destroy();
        return;
      }

      const responseHeaders = new Map<string, string>();
      for (const line of lines.slice(1)) {
        const separatorIndex = line.indexOf(":");
        if (separatorIndex === -1) {
          continue;
        }
        responseHeaders.set(line.slice(0, separatorIndex).trim().toLowerCase(), line.slice(separatorIndex + 1).trim());
      }

      if (responseHeaders.get("sec-websocket-accept") !== expectedAccept) {
        clearTimeout(timeout);
        reject(new CliError("WebSocket handshake validation failed.", EXIT_CODES.NETWORK));
        socket.destroy();
        return;
      }

      clearTimeout(timeout);
      connected = true;
      const client = new SimpleWebSocket(socket, handlers.onMessage, handlers.onClose);
      socket.removeAllListeners("data");
      socket.on("data", (data: any) => client.ingest(data));
      if (remainder.length > 0) {
        client.ingest(remainder);
      }
      resolve(client);
    });
  });
}
