/**
 * Exclusive voice-send floor (PR-D2 / K14 / K16).
 * duplex-speak is the only floor where the Talker pump may send Opus.
 * Player frames stay silent on that floor so two encoders never share a slot.
 */

export type VoiceFloor = "music" | "piper-ack" | "bumper" | "duplex-speak" | "silence";

export class VoiceFloorController {
  floor: VoiceFloor = "music";

  set(next: VoiceFloor): VoiceFloor {
    this.floor = next;
    return this.floor;
  }

  /** Player Opus may go to TeamSpeak. */
  playerSends(): boolean {
    return this.floor !== "duplex-speak";
  }

  /** Talker pump may send. */
  talkerSends(): boolean {
    return this.floor === "duplex-speak";
  }

  /**
   * Rising edge of Talker `speaking` steals the floor only from music/silence.
   * Piper acks and bumpers keep the floor. Falling edge restores music.
   */
  onTalkerSpeaking(speaking: boolean): VoiceFloor {
    if (speaking) {
      if (this.floor === "music" || this.floor === "silence") {
        this.floor = "duplex-speak";
      }
      return this.floor;
    }
    if (this.floor === "duplex-speak") this.floor = "music";
    return this.floor;
  }
}
