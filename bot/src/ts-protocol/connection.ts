/**
 * TS3 raw-TCP ServerQuery connection (port 10011).
 *
 * @deprecated This module only works with TS3 servers. TS6 servers replaced
 * the raw-TCP ServerQuery with HTTP/HTTPS (port 10080/10443) and SSH (10022).
 * For TS6 servers, use {@link ../http-query.js TS6HttpQuery} instead.
 */
import net from "node:net";
import { EventEmitter } from "node:events";
import { encodeCommand, decodeResponse, parseErrorLine } from "./commands.js";

export interface ConnectionOptions {
  host: string;
  port: number; // ServerQuery port: 10011 (TS3) — not available on TS6
}

export interface CommandResult {
  errorId: number;
  errorMessage: string;
  data: Record<string, string>[];
}

export class TS3Connection extends EventEmitter {
  private socket: net.Socket | null = null;
  private buffer = "";
  private commandQueue: Array<{
    resolve: (result: CommandResult) => void;
    reject: (err: Error) => void;
  }> = [];
  private connected = false;
  private responseLines: string[] = [];

  constructor(private options: ConnectionOptions) {
    super();
  }

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.socket = net.createConnection(
        this.options.port,
        this.options.host,
        () => {
          this.connected = true;
          resolve();
        }
      );

      this.socket.setEncoding("utf-8");
      this.socket.on("data", (data: string) => this.handleData(data));
      this.socket.on("error", (err) => {
        if (!this.connected) {
          reject(err);
        }
        this.emit("error", err);
      });
      this.socket.on("close", () => {
        this.connected = false;
        this.drainCommandQueue(new Error("Connection closed"));
        this.emit("close");
      });
    });
  }

  private handleData(data: string): void {
    this.buffer += data;
    const lines = this.buffer.split("\n\r");

    this.buffer = lines.pop() ?? "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      if (trimmed.startsWith("TS3") || trimmed.startsWith("Welcome"))
        continue;

      if (trimmed.startsWith("notify")) {
        this.handleNotification(trimmed);
        continue;
      }

      if (trimmed.startsWith("error ")) {
        const error = parseErrorLine(trimmed);
        const pending = this.commandQueue.shift();
        if (pending) {
          pending.resolve({
            errorId: error.id,
            errorMessage: error.msg,
            data:
              this.responseLines.length > 0
                ? decodeResponse(this.responseLines.join("\n"))
                : [],
          });
        }
        this.responseLines = [];
        continue;
      }

      this.responseLines.push(trimmed);
    }
  }

  private handleNotification(line: string): void {
    const spaceIndex = line.indexOf(" ");
    const notifyPart = spaceIndex === -1 ? line : line.substring(0, spaceIndex);
    const eventName = notifyPart.replace(/^notify/, "");
    const data =
      spaceIndex === -1
        ? {}
        : decodeResponse(line.substring(spaceIndex + 1))[0];
    this.emit("notify", eventName, data);
    this.emit(`notify:${eventName}`, data);
  }

  async send(
    command: string,
    params: Record<string, string | number> = {}
  ): Promise<CommandResult> {
    if (!this.socket || !this.connected) {
      throw new Error("Not connected");
    }

    const encoded = encodeCommand(command, params);

    return new Promise((resolve, reject) => {
      this.commandQueue.push({ resolve, reject });
      this.socket!.write(encoded);
    });
  }

  disconnect(): void {
    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
      this.connected = false;
    }
    this.drainCommandQueue(new Error("Disconnected"));
  }

  private drainCommandQueue(error: Error): void {
    for (const pending of this.commandQueue) {
      pending.reject(error);
    }
    this.commandQueue = [];
    this.responseLines = [];
  }

  isConnected(): boolean {
    return this.connected;
  }
}
