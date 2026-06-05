import dgram from "node:dgram";
import { EventEmitter } from "node:events";

export interface VoiceOptions {
  host: string;
  port: number; // same as virtual server port, typically 9987
}

export const CODEC_OPUS_VOICE = 4;
export const CODEC_OPUS_MUSIC = 5;

export class VoiceConnection extends EventEmitter {
  private socket: dgram.Socket | null = null;
  private packetCounter = 0;
  private clientId = 0;

  constructor(private options: VoiceOptions) {
    super();
  }

  setClientId(id: number): void {
    this.clientId = id;
  }

  async connect(): Promise<void> {
    return new Promise((resolve) => {
      this.socket = dgram.createSocket("udp4");

      this.socket.on("message", (msg) => {
        this.emit("voiceData", msg);
      });

      this.socket.on("error", (err) => {
        this.emit("error", err);
      });

      this.socket.connect(this.options.port, this.options.host, () => {
        resolve();
      });
    });
  }

  sendVoicePacket(
    opusData: Buffer,
    codec: number = CODEC_OPUS_MUSIC
  ): void {
    if (!this.socket) return;

    const packetId = this.packetCounter++;
    if (this.packetCounter > 0xffff) this.packetCounter = 0;

    const header = Buffer.alloc(5);
    header.writeUInt16BE(packetId, 0);
    header.writeUInt16BE(this.clientId, 2);
    header.writeUInt8(codec, 4);

    const packet = Buffer.concat([header, opusData]);
    this.socket.send(packet);
  }

  sendKeepAlive(): void {
    if (!this.socket) return;
    const ping = Buffer.alloc(4);
    ping.writeUInt16BE(this.packetCounter++, 0);
    ping.writeUInt16BE(this.clientId, 2);
    if (this.packetCounter > 0xffff) this.packetCounter = 0;
    this.socket.send(ping);
  }

  disconnect(): void {
    if (this.socket) {
      this.socket.close();
      this.socket = null;
    }
  }
}
